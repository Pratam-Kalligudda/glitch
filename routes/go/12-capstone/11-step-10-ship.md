---
title: "Step 10: ship it"
done_when: "`./dist/linkcheck-windows-amd64.exe -version` (or the binary for your platform) prints `linkcheck v1.0.0 (<commit>) go1.27.1 <os>/<arch>`, `go version -m` on the Linux binary shows `vcs.modified=false` and `-pgo=default.pgo`, four binaries build from one machine, and `-open` writes `linkcheck-report.html` and hands it to the platform's opener."
---
linkcheck becomes a release: it reports its version from the build information and `-ldflags`, builds with a profile for profile-guided optimisation, cross-compiles to four platforms from one machine, opens its HTML report in the browser with a per-OS command chosen by build constraints, and fails on a bad `-out` path before it crawls.

Do this yourself first, then compare.

1. Read the module version, commit and dirty flag with `debug.ReadBuildInfo`, let `-ldflags "-X main.version=..."` override it, and compute it once with `sync.OnceValue` ([[build-info]], [[once-atomic]]).
2. Add `-version`, and use the version in the default User-Agent ([[flags-args]]).
3. Write `openCommand` three times, in `open_windows.go`, `open_darwin.go` and `open_other.go` with a `//go:build` line, and run it with `os/exec` without waiting ([[build-tags]], [[os-exec]]).
4. Create the output file before the crawl, and check the error from `Close` ([[os-files]], [[exit-codes]]).
5. Run `gofmt`, `go vet` for every target OS, and `go fix -diff` ([[vet-fmt-fix]]).
6. Commit, tag `v1.0.0`, and see the tag and commit appear in the binary ([[toolchain]], [[modules]]).
7. Save a CPU profile as `default.pgo` and measure whether it helps ([[pgo]], [[benchmarks]]).
8. Cross-compile with `GOOS`, `GOARCH`, `CGO_ENABLED=0`, `-trimpath` and `-ldflags "-s -w"` ([[cross-compile]]).

## The code

New: `version.go`, `open.go`, `open_windows.go`, `open_darwin.go`, `open_other.go`, `.gitignore`, `default.pgo` (generated below). Changed: `main.go`. Unchanged: every other file, including `go.mod`.

```go title="version.go"
package main

import (
	"fmt"
	"runtime"
	"runtime/debug"
	"sync"
)

// version is set at build time with
//
//	go build -ldflags "-X main.version=v1.0.0"
//
// and is empty otherwise.
var version string

// buildVersion is the version linkcheck reports. It prefers the -ldflags
// value, then the module version recorded by go install, then "dev". It
// adds the commit and whether the tree had uncommitted changes when the
// build recorded them. sync.OnceValue computes it once, on first use.
var buildVersion = sync.OnceValue(func() string {
	v := version
	info, ok := debug.ReadBuildInfo()
	if v == "" && ok && info.Main.Version != "" && info.Main.Version != "(devel)" {
		v = info.Main.Version
	}
	if v == "" {
		v = "dev"
	}
	if !ok {
		return v
	}
	var rev, modified string
	for _, s := range info.Settings {
		switch s.Key {
		case "vcs.revision":
			rev = s.Value
		case "vcs.modified":
			modified = s.Value
		}
	}
	if len(rev) > 12 {
		rev = rev[:12]
	}
	if rev != "" {
		v += " (" + rev
		if modified == "true" {
			v += ", modified"
		}
		v += ")"
	}
	return v
})

// versionLine is what -version prints.
func versionLine() string {
	return fmt.Sprintf("linkcheck %s %s %s/%s", buildVersion(), runtime.Version(), runtime.GOOS, runtime.GOARCH)
}
```

`version` is an ordinary package variable with no value. `-ldflags "-X main.version=v1.0.0"` tells the linker to set it, so a release script can stamp any string without editing code. Without it, `debug.ReadBuildInfo` still knows a lot: since Go 1.24, `go build` in a Git checkout sets `Main.Version` from the tag on the current commit, adds `+dirty` when there are uncommitted changes, and records the commit in the `vcs.revision` setting. A build outside version control reports `(devel)`, which `buildVersion` turns into `dev`.

`sync.OnceValue` wraps the function so the first call computes the string and every later call returns it, safely from any goroutine. Here it runs during flag setup, for the default User-Agent, and again for `-version`.

```go title="open.go"
package main

import (
	"fmt"
	"os"
	"path/filepath"
)

// openReport opens the HTML report at path in the default browser. It
// starts the opener and does not wait for it: the browser may keep
// running long after linkcheck exits.
func openReport(path string) error {
	abs, err := filepath.Abs(path)
	if err != nil {
		return err
	}
	cmd := openCommand(abs)
	cmd.Stdout, cmd.Stderr = os.Stderr, os.Stderr
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("open %s: %w", abs, err)
	}
	// Release the child's resources; its exit status is of no interest.
	return cmd.Process.Release()
}
```

```go title="open_windows.go"
package main

import "os/exec"

// openCommand returns the command that opens path in the default
// browser. rundll32 takes the path as a single argument, so no shell
// parses it and spaces or & in the path are harmless.
func openCommand(path string) *exec.Cmd {
	return exec.Command("rundll32", "url.dll,FileProtocolHandler", path)
}
```

```go title="open_darwin.go"
package main

import "os/exec"

// openCommand returns the command that opens path in the default
// browser.
func openCommand(path string) *exec.Cmd {
	return exec.Command("open", path)
}
```

```go title="open_other.go"
//go:build !windows && !darwin

package main

import "os/exec"

// openCommand returns the command that opens path in the default
// browser on Linux and the BSDs, through the desktop's xdg-open.
func openCommand(path string) *exec.Cmd {
	return exec.Command("xdg-open", path)
}
```

The file name suffixes `_windows` and `_darwin` are build constraints on their own: the go command compiles `open_windows.go` only for `GOOS=windows`. `open_other.go` needs an explicit `//go:build !windows && !darwin` line, so exactly one `openCommand` exists for every target. `go list` shows the choice:

```bash
go list -f '{{.GoFiles}}' .
GOOS=linux go list -f '{{.GoFiles}}' .
```

```text
[config.go flags.go main.go open.go open_windows.go pprof.go preflight.go progress.go serve.go version.go]
[config.go flags.go main.go open.go open_other.go pprof.go preflight.go progress.go serve.go version.go]
```

`exec.Command` takes the program and its arguments as separate strings and runs the program directly, with no shell. A report path with spaces or `&` in it reaches the opener as one argument. `cmd.Start` returns as soon as the opener is running; `Wait` is never called, so `Process.Release` frees the handle.

```go title="main.go"
// Command linkcheck crawls a website and reports broken links.
package main

import (
	"cmp"
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"sync"
	"time"
	"uuid"

	"example.com/linkcheck/internal/crawl"
	"example.com/linkcheck/internal/report"
	"example.com/linkcheck/internal/state"
)

// Exit codes.
const (
	exitOK          = 0   // every link works
	exitBroken      = 1   // at least one link is broken
	exitError       = 2   // linkcheck could not run
	exitInterrupted = 130 // stopped by Ctrl-C; the report is partial
)

// config holds the settings from the command line.
type config struct {
	starts    []string
	depth     int
	workers   int
	verbose   bool
	rate      rateFlag
	timeout   time.Duration
	checkTCP  bool
	userAgent string
	include   regexpList
	exclude   regexpList
	format    string
	out       string
	serve     string
	stateFile string
	pprofAddr string
	open      bool
}

func main() {
	cfg := config{rate: rateFlag{n: 10, per: time.Second}}
	flag.IntVar(&cfg.depth, "depth", 3, "follow links up to `n` clicks from the start page")
	flag.IntVar(&cfg.workers, "workers", 8, "check up to `n` links at once")
	flag.BoolVar(&cfg.verbose, "v", false, "log every check to stderr")
	flag.Var(&cfg.rate, "rate", "at most `N/PERIOD` requests to each host, such as 10/s or 30/m; 0 for no limit")
	flag.DurationVar(&cfg.timeout, "timeout", 10*time.Second, "give up on a request after `d`")
	flag.BoolVar(&cfg.checkTCP, "check-tcp", false, "connect to each start host before crawling")
	flag.StringVar(&cfg.userAgent, "user-agent", "linkcheck/"+strings.Fields(buildVersion())[0], "User-Agent header to send")
	flag.Var(&cfg.include, "include", "only check links matching `regexp` (repeatable)")
	flag.Var(&cfg.exclude, "exclude", "skip links matching `regexp` (repeatable)")
	flag.StringVar(&cfg.format, "format", "text", "report `format`: text, json, csv, junit or html")
	flag.StringVar(&cfg.out, "out", "", "write the report to `file` instead of stdout")
	flag.StringVar(&cfg.serve, "serve", "", "after the crawl, serve the HTML report on `addr`, such as 127.0.0.1:8090")
	flag.StringVar(&cfg.stateFile, "state", "", "resume from `file` if it exists; save to it when interrupted")
	flag.StringVar(&cfg.pprofAddr, "pprof", "", "serve runtime profiles on `addr`, such as 127.0.0.1:6060")
	flag.BoolVar(&cfg.open, "open", false, "write the HTML report (to -out, default linkcheck-report.html) and open it in the browser")
	showVersion := flag.Bool("version", false, "print the version and exit")
	configPath := flag.String("config", "", "read settings from the JSON `file`; flags win")
	flag.Usage = func() {
		fmt.Fprintln(flag.CommandLine.Output(), "usage: linkcheck [flags] URL...")
		flag.PrintDefaults()
	}
	flag.Parse()
	if *showVersion {
		fmt.Println(versionLine())
		os.Exit(exitOK)
	}
	cfg.starts = flag.Args()
	set := make(map[string]bool)
	flag.Visit(func(f *flag.Flag) { set[f.Name] = true })
	if *configPath != "" {
		fc, err := loadConfig(*configPath)
		if err == nil {
			err = fc.apply(&cfg, set)
		}
		if err != nil {
			fmt.Fprintf(os.Stderr, "linkcheck: config: %v\n", err)
			os.Exit(exitError)
		}
	}
	if len(cfg.starts) == 0 {
		flag.Usage()
		os.Exit(exitError)
	}
	if cfg.open {
		if set["format"] && cfg.format != "html" {
			fmt.Fprintln(os.Stderr, "linkcheck: -open needs -format html")
			os.Exit(exitError)
		}
		cfg.format = "html"
		cfg.out = cmp.Or(cfg.out, "linkcheck-report.html")
	}

	// The first Ctrl-C cancels ctx; stop restores the default behaviour,
	// so a second Ctrl-C kills the process at once.
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	code := run(ctx, cfg, os.Stdout, os.Stderr)
	stop()
	os.Exit(code)
}

func run(ctx context.Context, cfg config, stdout, stderr io.Writer) int {
	level := slog.LevelWarn
	if cfg.verbose {
		level = slog.LevelDebug
	}
	logger := slog.New(slog.NewTextHandler(stderr, &slog.HandlerOptions{Level: level}))

	// cmp.Or returns its first non-zero argument: an empty format is text.
	reporter, err := report.ByName(cmp.Or(cfg.format, "text"))
	if err != nil {
		fmt.Fprintf(stderr, "linkcheck: %v\n", err)
		return exitError
	}

	// Create the output file before crawling, so a bad path fails at
	// once instead of after a long crawl.
	out, closeOut, err := openOutput(cfg.out, stdout)
	if err != nil {
		fmt.Fprintf(stderr, "linkcheck: %v\n", err)
		return exitError
	}
	defer closeOut()

	if cfg.pprofAddr != "" {
		if err := startPprof(cfg.pprofAddr, stderr); err != nil {
			fmt.Fprintf(stderr, "linkcheck: pprof: %v\n", err)
			return exitError
		}
	}

	if cfg.checkTCP {
		if err := checkTCP(ctx, cfg.starts, cfg.timeout); err != nil {
			fmt.Fprintf(stderr, "linkcheck: %v\n", err)
			return exitError
		}
	}

	c := &crawl.Crawler{
		Fetcher: &crawl.HTTPFetcher{
			Client:    &http.Client{},
			UserAgent: cfg.userAgent,
		},
		MaxDepth: cfg.depth,
		Workers:  cfg.workers,
		Logger:   logger,
		Limiter:  &crawl.HostLimiter{Limit: cfg.rate.Limit(), Burst: 1},
		Timeout:  cfg.timeout,
		Filter:   crawl.Filter{Include: cfg.include, Exclude: cfg.exclude},
	}
	// A version 7 UUID starts with a timestamp, so run IDs sort by the
	// time the crawl started.
	runID := uuid.NewV7()
	st := &crawl.State{Starts: cfg.starts}
	if cfg.stateFile != "" {
		id, saved, err := state.Load(cfg.stateFile)
		switch {
		case err == nil:
			runID, st = id, saved
			fmt.Fprintf(stderr, "resuming run %s: %d done, %d pending\n", runID, len(st.Results), len(st.Pending))
		case errors.Is(err, fs.ErrNotExist):
			// No saved crawl: start a new one.
		default:
			fmt.Fprintf(stderr, "linkcheck: %v\n", err)
			return exitError
		}
	}
	ctx = crawl.WithRunID(ctx, runID.String())
	c.Logger = logger.With("run", runID.String())

	stopProgress := func() {}
	if cfg.verbose {
		stopProgress = logProgress(logger, c)
	}
	started := time.Now()
	st, err = c.Resume(ctx, st)
	stopProgress()
	interrupted := errors.Is(err, context.Canceled)
	if err != nil && !interrupted {
		fmt.Fprintf(stderr, "linkcheck: %v\n", err)
		return exitError
	}
	results := st.Results
	if cfg.stateFile != "" {
		if err := saveOrClear(cfg.stateFile, runID, st, interrupted, stderr); err != nil {
			fmt.Fprintf(stderr, "linkcheck: state: %v\n", err)
			return exitError
		}
	}
	if len(results) == 0 {
		fmt.Fprintln(stderr, "linkcheck: interrupted before a start page loaded")
		return exitInterrupted
	}
	for _, r := range results {
		if r.Depth == 0 && r.Err != nil {
			fmt.Fprintf(stderr, "linkcheck: start page: %v\n", r.Err)
			return exitError
		}
	}

	rep := &report.Report{
		RunID:       runID.String(),
		Starts:      cfg.starts,
		Started:     started,
		Elapsed:     time.Since(started),
		Interrupted: interrupted,
		Results:     results,
	}
	if err := reporter.Report(out, rep); err != nil {
		fmt.Fprintf(stderr, "linkcheck: %v\n", err)
		return exitError
	}
	// A write error can surface only at Close, so check it here rather
	// than leaving it to the deferred call, which ignores it.
	if err := closeOut(); err != nil {
		fmt.Fprintf(stderr, "linkcheck: %v\n", err)
		return exitError
	}
	if cfg.open {
		if err := openReport(cfg.out); err != nil {
			fmt.Fprintf(stderr, "linkcheck: %v\n", err)
			return exitError
		}
	}
	if cfg.serve != "" && !interrupted {
		if err := serveReport(ctx, cfg.serve, rep, stderr); err != nil {
			fmt.Fprintf(stderr, "linkcheck: serve: %v\n", err)
			return exitError
		}
	}

	switch {
	case interrupted:
		return exitInterrupted
	case rep.Count(crawl.Broken) > 0:
		return exitBroken
	}
	return exitOK
}

// openOutput returns where the report goes: the file at path, created
// now, or stdout when path is empty. The close function may be called more
// than once; only the first call closes the file and returns its error.
func openOutput(path string, stdout io.Writer) (io.Writer, func() error, error) {
	if path == "" {
		return stdout, func() error { return nil }, nil
	}
	f, err := os.Create(path)
	if err != nil {
		return nil, nil, err
	}
	return f, sync.OnceValue(f.Close), nil
}

// saveOrClear saves an interrupted crawl to path, or removes path once the
// crawl is complete so the next run starts fresh.
func saveOrClear(path string, runID uuid.UUID, st *crawl.State, interrupted bool, stderr io.Writer) error {
	if !interrupted {
		if err := os.Remove(path); err != nil && !errors.Is(err, fs.ErrNotExist) {
			return err
		}
		return nil
	}
	if err := state.Save(path, runID, st); err != nil {
		return err
	}
	fmt.Fprintf(stderr, "saved run %s to %s: %d done, %d pending; run again with -state %s to resume\n",
		runID, path, len(st.Results), len(st.Pending), path)
	return nil
}
```

Two changes beyond the new flags. `-open` switches the format to HTML and picks a default file name, and refuses an explicit non-HTML format instead of guessing. And the output file is now created before the crawl, with `openOutput` returning a close function wrapped in `sync.OnceValue`: the deferred call covers every early return, and the explicit call after `Report` is the one whose error is checked. Since step 7, `-out missing-dir/report.txt` failed only after a full crawl; now it fails at once.

```text title=".gitignore"
/linkcheck
/linkcheck.exe
/dist/
*.out
*.test
*.test.exe
linkcheck-report.html
crawl.json.gz
```

## Check, commit and tag

```bash
gofmt -l .
go vet ./...
GOOS=linux go vet ./...
GOOS=darwin go vet ./...
go fix -diff ./...
go test -count=1 -race ./...
```

```text
ok  	example.com/linkcheck	2.569s
?   	example.com/linkcheck/cmd/testsite	[no test files]
ok  	example.com/linkcheck/internal/crawl	2.758s
ok  	example.com/linkcheck/internal/report	2.550s
ok  	example.com/linkcheck/internal/state	2.531s
```

`gofmt`, the three `go vet` runs and `go fix -diff` print nothing: the code is formatted, vet finds nothing on any target, and none of the modernizers in `go fix` has a change to suggest. Vetting with `GOOS=linux` and `GOOS=darwin` type-checks `open_other.go` and `open_darwin.go`, which a Windows build never compiles.

Commit and tag the release:

```bash
git init
git add -A
git commit -m "linkcheck v1.0.0"
git tag v1.0.0
go build .
./linkcheck -version
```

```text
linkcheck v1.0.0 (b12c48668dd9) go1.27.1 windows/amd64
```

No `-ldflags`: the version came from the tag and the commit from Git, through `debug.ReadBuildInfo`. Change any tracked file and build again:

```text
linkcheck v1.0.0+dirty (b12c48668dd9, modified) go1.27.1 windows/amd64
```

A binary built from uncommitted code says so. Restore the file before building the release.

## Profile-guided optimisation

Save a CPU profile of the hottest code as `default.pgo` in the main package's directory. `go build` uses a `default.pgo` there automatically (`-pgo=auto`):

```bash
go test -run '^$' -bench Links -benchtime 5s -cpuprofile default.pgo ./internal/crawl
```

Measure it: the same benchmark built without and with the profile, ten runs each, on one CPU. The first attempt ran the build without PGO first:

```bash
go test -run '^$' -bench Links -cpu 1 -count 10 -pgo=off ./internal/crawl > nopgo.txt
go test -run '^$' -bench Links -cpu 1 -count 10 -pgo=$PWD/default.pgo ./internal/crawl > pgo.txt
benchstat nopgo.txt pgo.txt
```

```text
      │    sec/op    │    sec/op     vs base                │
Links   4.011m ± 21%   2.762m ± 22%  -31.14% (p=0.000 n=10)
```

A 31% gain looked too good, so the runs were repeated in the opposite order, PGO first:

```text
      │   sec/op    │    sec/op     vs base          │
Links   2.853m ± 6%   2.799m ± 25%  ~ (p=0.436 n=10)
```

No significant difference (`~`, p=0.436). The first "gain" was the laptop: whichever set ran first ran at a different clock speed. PGO mostly helps by inlining hot calls more aggressively, and this benchmark's time is spent inside `x/net/html` and `net/url` loops it barely changes. The profile stays in the repository because it costs nothing and helps as the code grows, but the honest claim is "no measurable gain on this benchmark".

## Cross-compile

```bash
for t in linux/amd64 linux/arm64 darwin/arm64 windows/amd64; do
  os=${t%/*}; arch=${t#*/}; ext=
  [ $os = windows ] && ext=.exe
  CGO_ENABLED=0 GOOS=$os GOARCH=$arch go build -trimpath -ldflags "-s -w -X main.version=v1.0.0" -o dist/linkcheck-$os-$arch$ext .
done
ls -l dist
file dist/*
```

```text
total 41252
-rw-r--r-- 1 Pratam 197121 10264274 Oct  3 19:21 linkcheck-darwin-arm64
-rw-r--r-- 1 Pratam 197121 10809504 Oct  3 19:21 linkcheck-linux-amd64
-rw-r--r-- 1 Pratam 197121 10027168 Oct  3 19:21 linkcheck-linux-arm64
-rwxr-xr-x 1 Pratam 197121 11132928 Oct  3 19:22 linkcheck-windows-amd64.exe
dist/linkcheck-darwin-arm64:      Mach-O 64-bit arm64 executable, flags:<|DYLDLINK|PIE>
dist/linkcheck-linux-amd64:       ELF 64-bit LSB executable, x86-64, version 1 (SYSV), statically linked, Go BuildID=wpr3i2sH0XzColsZblrZ/qfkNdslp4yyS8TFtrDw4/L5gAeQ8X2nDH0JtEGr23/w9dkVWdL8iFI7xx1vKvF, BuildID[sha1]=27462685ff7c791cb947bf65d3e4fdc431fff33b, stripped
dist/linkcheck-linux-arm64:       ELF 64-bit LSB executable, ARM aarch64, version 1 (SYSV), statically linked, Go BuildID=z2hW4eE5-JUNtyA2Twi4/D7TWuHHG6tt0Oj3-POCl/JCJyAoBlV4PVDAhJxc0H/YYRZZRhZmUDk0f_2nonQ, BuildID[sha1]=17fbf0f4c8db13cd93548a9c66f02310913ec9ab, stripped
dist/linkcheck-windows-amd64.exe: PE32+ executable for MS Windows 10.00 (console), x86-64, 8 sections
```

Four binaries from one Windows machine, with no cross-compiler installed. What each flag does:

| Setting | Effect |
|---|---|
| `GOOS`, `GOARCH` | The target operating system and CPU |
| `CGO_ENABLED=0` | No C code, so the Linux binaries are statically linked and run on any distribution |
| `-trimpath` | Removes your local file paths from the binary and its stack traces |
| `-ldflags "-s -w"` | Drops the symbol table and DWARF debug data: 11 MB here instead of 16 MB for a plain `go build` |
| `-ldflags "-X main.version=v1.0.0"` | Sets the `version` variable at link time |

The build information travels inside every binary, whatever platform it was built for, and `go version -m` reads it without running the program (dependency lines left out):

```bash
go version -m dist/linkcheck-linux-amd64
```

```text
dist/linkcheck-linux-amd64: go1.27.1
	path	example.com/linkcheck
	mod	example.com/linkcheck	v1.0.0	
	build	-buildmode=exe
	build	-compiler=gc
	build	-pgo=default.pgo
	build	-trimpath=true
	build	CGO_ENABLED=0
	build	GOAMD64=v1
	build	GOARCH=amd64
	build	GOOS=linux
	build	vcs=git
	build	vcs.modified=false
	build	vcs.revision=b12c48668dd946c7a7e9b9511691d86e25982fa7
	build	vcs.time=2026-10-03T13:50:10Z
```

`-pgo=default.pgo` confirms the profile was used; `vcs.modified=false` confirms the release was built from the tagged commit.

## Run the release

With the testsite running, run the binary for your platform:

```bash
./dist/linkcheck-windows-amd64.exe -version
./dist/linkcheck-windows-amd64.exe -config linkcheck.json; echo "exit $?"
```

```text
linkcheck v1.0.0 (b12c48668dd9) go1.27.1 windows/amd64
http://127.0.0.1:8080/
  500  http://127.0.0.1:8080/error
  404  http://127.0.0.1:8080/missing.html
  ERR  http://127.0.0.1:8099/
       dial tcp 127.0.0.1:8099: connectex: No connection could be made because the target machine actively refused it.
http://127.0.0.1:8080/about.html
  404  http://127.0.0.1:8080/team.html
http://127.0.0.1:8080/blog/post-1.html
  404  http://127.0.0.1:8080/blog/archive/2019.html
http://127.0.0.1:8080/blog/post-2.html
  404  http://127.0.0.1:8080/blog/drafts/
same content:
  http://127.0.0.1:8080/about-print.html
  http://127.0.0.1:8080/about.html
13 links checked, 6 broken, 4 excluded
exit 1
```

Open the HTML report in your browser:

```bash
./linkcheck -open -config linkcheck.json; echo "exit $?"
```

```text
exit 1
```

Nothing is printed: the report went to `linkcheck-report.html`, and the browser opens it. On Windows the program started was exactly:

```text
["rundll32" "url.dll,FileProtocolHandler" "C:\\...\\linkcheck-report.html"]
```

(captured by putting a stand-in `rundll32.exe` that logs its arguments first on the `PATH`; the path is shortened here). The two mistakes `-open` and `-out` now catch before crawling:

```bash
./linkcheck -open -format json http://127.0.0.1:8080/; echo "exit $?"
./linkcheck -out nodir/r.txt http://127.0.0.1:8080/; echo "exit $?"
```

```text
linkcheck: -open needs -format html
exit 2
linkcheck: open nodir/r.txt: The system cannot find the path specified.
exit 2
```

The full set of flags in the release:

```bash
./linkcheck -h
```

```text
usage: linkcheck [flags] URL...
  -check-tcp
    	connect to each start host before crawling
  -config file
    	read settings from the JSON file; flags win
  -depth n
    	follow links up to n clicks from the start page (default 3)
  -exclude regexp
    	skip links matching regexp (repeatable)
  -format format
    	report format: text, json, csv, junit or html (default "text")
  -include regexp
    	only check links matching regexp (repeatable)
  -open
    	write the HTML report (to -out, default linkcheck-report.html) and open it in the browser
  -out file
    	write the report to file instead of stdout
  -pprof addr
    	serve runtime profiles on addr, such as 127.0.0.1:6060
  -rate N/PERIOD
    	at most N/PERIOD requests to each host, such as 10/s or 30/m; 0 for no limit (default 10/s)
  -serve addr
    	after the crawl, serve the HTML report on addr, such as 127.0.0.1:8090
  -state file
    	resume from file if it exists; save to it when interrupted
  -timeout d
    	give up on a request after d (default 10s)
  -user-agent string
    	User-Agent header to send (default "linkcheck/v1.0.0")
  -v	log every check to stderr
  -version
    	print the version and exit
  -workers n
    	check up to n links at once (default 8)
```

> [!WARNING]
> `exec.Command("cmd", "/c", "start", path)` is the opener many examples use on Windows. `cmd` re-parses its command line, so a report path containing `&` or `^` is split or mangled, and a crafted file name can run a second command. `rundll32 url.dll,FileProtocolHandler` takes the path as one argument and no shell is involved.

linkcheck is done: a concurrent, polite, resumable link checker with five report formats, a test suite that runs in about a second, measured performance, and versioned binaries for four platforms, built from the ideas in every part of this route.
