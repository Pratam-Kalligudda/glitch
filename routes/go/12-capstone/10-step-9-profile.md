---
title: "Step 9: profile and tune"
done_when: "`benchstat` on ten runs before and after the change shows `BenchmarkLinks` at about half the bytes and allocations per operation (52.43k to 26.79k allocs/op here), `go test ./...` passes including the goroutine leak test, and `/debug/pprof/goroutineleak?debug=1` on a running crawl reports `total 0`."
---
linkcheck gets a benchmark for its hottest code, a CPU and heap profile of it, an allocation fix that halves the memory `Links` allocates, a test that asks the runtime for leaked goroutines, and a `-pprof` flag that exposes live profiles of a running crawl.

Do this yourself first, then compare.

1. Write `BenchmarkLinks` over a generated page with 2,000 links, using `b.Loop`, `b.ReportAllocs` and `b.SetBytes`; build the page with a `strings.Builder` ([[benchmarks]], [[pools-builders]]).
2. Run it ten times and keep the output for `benchstat` ([[benchmarks]]).
3. Record a CPU profile and a heap profile from the benchmark and read them with `go tool pprof -top` and `-list` ([[pprof-cpu]], [[pprof-heap]]).
4. Replace the tree built by `html.Parse` with the streaming `html.Tokenizer`, and check with `-gcflags=-m` what still escapes ([[escape-analysis]], [[io-composition]]).
5. Measure again, also with `-cpu 1`, and explain why fewer allocations matter more on one CPU ([[gc-tuning]]).
6. Write a test that cancels a crawl and reads the `goroutineleak` profile (generally available in Go 1.27) ([[goroutine-leaks]]).
7. Add `-pprof`, which serves `net/http/pprof` on its own address ([[http-server]], [[pprof-cpu]]).

## The code

New: `pprof.go`, `internal/crawl/links_bench_test.go`, `internal/crawl/leak_test.go`. Changed: `main.go`, `internal/crawl/links.go`. Unchanged: everything else, including `go.mod`: `golang.org/x/net/html` already has the tokenizer.

### Measure first

```go title="internal/crawl/links_bench_test.go"
package crawl

import (
	"bytes"
	"fmt"
	"net/url"
	"strings"
	"testing"
)

// bigPage builds a page shaped like a real one: navigation, paragraphs
// of text, and n links of the usual kinds.
func bigPage(n int) []byte {
	var b strings.Builder
	b.WriteString("<!doctype html><html><head><title>Archive</title></head><body><nav>")
	for i := range 20 {
		fmt.Fprintf(&b, `<a href="/section/%d/">Section %d</a> `, i, i)
	}
	b.WriteString("</nav><main>")
	for i := range n {
		switch i % 4 {
		case 0:
			fmt.Fprintf(&b, `<p>Post number %d is about links. <a href="post-%d.html">Read it</a>.</p>`, i, i)
		case 1:
			fmt.Fprintf(&b, `<p>See <a href="/tags/%d#top" class="tag">tag %d</a> too.</p>`, i, i)
		case 2:
			fmt.Fprintf(&b, `<p>An <a href="https://Example.COM:443/ref/%d">external reference</a>.</p>`, i)
		case 3:
			fmt.Fprintf(&b, `<div class="meta"><span>%d comments</span> <a href="mailto:x%d@example.com">mail</a></div>`, i, i)
		}
	}
	b.WriteString("</main></body></html>")
	return []byte(b.String())
}

func BenchmarkLinks(b *testing.B) {
	page := bigPage(2000)
	base, err := url.Parse("http://example.com/blog/")
	if err != nil {
		b.Fatal(err)
	}
	b.SetBytes(int64(len(page)))
	b.ReportAllocs()
	for b.Loop() {
		if _, err := Links(base, bytes.NewReader(page)); err != nil {
			b.Fatal(err)
		}
	}
}
```

`b.Loop` (Go 1.24) runs the body as many times as the benchmark needs and keeps the setup above it out of the timing, so `bigPage` runs once. `SetBytes` adds a throughput column, and `ReportAllocs` the two allocation columns.

Run it on the step 8 version of `links.go`, ten times so the noise can be measured:

```bash
go test -run '^$' -bench Links -count 10 ./internal/crawl > before.txt
head -6 before.txt
```

```text
goos: windows
goarch: amd64
pkg: example.com/linkcheck/internal/crawl
cpu: 13th Gen Intel(R) Core(TM) i7-1355U
BenchmarkLinks-12    	     344	   3619527 ns/op	  42.79 MB/s	 2780560 B/op	   52429 allocs/op
BenchmarkLinks-12    	     310	   4256138 ns/op	  36.39 MB/s	 2780499 B/op	   52429 allocs/op
```

About 4 ms and 2.7 MB per page, in 52,429 allocations: 26 allocations per link. `-run '^$'` matches no test, so only the benchmark runs. Your times will differ; the allocation counts will not.

Profile the same benchmark:

```bash
go test -run '^$' -bench Links -benchtime 3s -cpuprofile cpu.out -memprofile mem.out ./internal/crawl
go tool pprof -sample_index=alloc_space -top -nodecount 12 mem.out
```

```text
Showing nodes accounting for 1.90GB, 99.49% of 1.91GB total
Dropped 55 nodes (cum <= 0.01GB)
Showing top 12 nodes out of 38
      flat  flat%   sum%        cum   cum%
    0.49GB 25.49% 25.49%     0.49GB 25.49%  golang.org/x/net/html.(*parser).addText
    0.34GB 17.87% 43.36%     0.34GB 17.87%  net/url.parse
    0.34GB 17.69% 61.05%     0.34GB 17.72%  golang.org/x/net/html.(*parser).addElement
    0.20GB 10.40% 71.45%     0.22GB 11.40%  net/url.(*URL).ResolveReference
    0.18GB  9.46% 80.91%     0.28GB 14.44%  golang.org/x/net/html.(*Tokenizer).Token
    0.12GB  6.13% 87.04%     0.76GB 39.77%  example.com/linkcheck/internal/crawl.Links-range1
    0.10GB  4.98% 92.02%     0.10GB  4.98%  bytes.Replace
    0.06GB  3.07% 95.09%     0.06GB  3.07%  internal/bytealg.MakeNoZero
    0.02GB  1.30% 96.39%     0.02GB  1.30%  net.SplitHostPort.func1 (inline)
    0.02GB  1.30% 97.70%     0.04GB  2.10%  golang.org/x/net/html.(*Tokenizer).readTag
    0.02GB     1% 98.69%     0.02GB     1%  net/url.(*URL).Parse
    0.02GB  0.79% 99.49%     0.02GB  0.79%  bytes.Clone (inline)
```

`-sample_index=alloc_space` counts every byte allocated during the run, not only what is still live, which is what matters for allocation work. `-list` maps the totals to lines of `Links`:

```bash
go tool pprof -sample_index=alloc_space -list 'crawl.Links' mem.out
```

```text
ROUTINE ======================== example.com/linkcheck/internal/crawl.Links in ...\internal\crawl\links.go
         0     1.90GB (flat, cum) 99.62% of Total
         .     1.14GB     15:	doc, err := html.Parse(r)
         .   777.93MB     21:	for n := range doc.Descendants() {
ROUTINE ======================== example.com/linkcheck/internal/crawl.Links-range1 in ...\internal\crawl\links.go
  119.85MB   777.93MB (flat, cum) 39.77% of Total
         .   658.08MB     29:			s, err := Normalize(base, attr.Val)
   78.71MB    78.71MB     34:				seen[s] = true
   41.15MB    41.15MB     35:				links = append(links, s)
```

(Lines with no allocations are left out here, and the long scratch path is shortened to `...`.) Sixty percent of the bytes go into `html.Parse` building a tree: a node for every element (`addElement`) and for every run of text (`addText`), a `Token` for every tag. `Links` then walks that tree to look at `<a>` elements only. The CPU profile tells the same story: `html.(*parser).parse` is 48% of the samples, and garbage collection functions (`runtime.scanObjectsSmall`, `runtime.mallocgcTinySC2`) are among the top entries.

```bash
go tool pprof -top -nodecount 15 crawl.test.exe cpu.out
```

```text
      flat  flat%   sum%        cum   cum%
     350ms  5.57%  5.57%      360ms  5.73%  golang.org/x/net/html.(*Tokenizer).readByte
     230ms  3.66%  9.24%      500ms  7.96%  runtime.scanObjectsSmall
     230ms  3.66% 12.90%      310ms  4.94%  runtime.tryDeferToSpanScan
     220ms  3.50% 16.40%      220ms  3.50%  runtime.preemptM
     190ms  3.03% 19.43%      320ms  5.10%  runtime.mallocgcTinySC2
     170ms  2.71% 22.13%      450ms  7.17%  runtime.growslice
     150ms  2.39% 24.52%     3040ms 48.41%  golang.org/x/net/html.(*parser).parse
     130ms  2.07% 26.59%      130ms  2.07%  runtime.semasleep
     120ms  1.91% 28.50%     1050ms 16.72%  golang.org/x/net/html.(*Tokenizer).Next
     120ms  1.91% 30.41%     1060ms 16.88%  golang.org/x/net/html.(*Tokenizer).Token
     120ms  1.91% 32.32%      120ms  1.91%  runtime.memclrNoHeapPointers
     120ms  1.91% 34.24%      120ms  1.91%  runtime.sysUnusedOS
      90ms  1.43% 35.67%       90ms  1.43%  runtime.sysUsedOS
      80ms  1.27% 36.94%      730ms 11.62%  golang.org/x/net/html.(*Tokenizer).readTag
      80ms  1.27% 38.22%      130ms  2.07%  golang.org/x/net/html.(*parser).indexOfElementInScope
```

`go test -cpuprofile` keeps the test binary (`crawl.test.exe` on Windows, `crawl.test` elsewhere) next to the profile, so `pprof` can resolve the symbols.

### The fix

```go title="internal/crawl/links.go"
// Package crawl fetches HTML pages and finds the links in them.
package crawl

import (
	"errors"
	"io"
	"net/url"

	"golang.org/x/net/html"
)

// Links reads the HTML document in r and returns the http and https URLs
// of its <a href> links, resolved against base and normalized with
// Normalize. Each URL appears once, in document order.
//
// Links streams the document through the tokenizer instead of building a
// tree with html.Parse: it needs only the <a> start tags, and skipping the
// tree avoids allocating a node for every element and every run of text.
func Links(base *url.URL, r io.Reader) ([]string, error) {
	z := html.NewTokenizer(r)
	var links []string
	seen := make(map[string]bool)
	for {
		switch z.Next() {
		case html.ErrorToken:
			if err := z.Err(); !errors.Is(err, io.EOF) {
				return links, err
			}
			return links, nil
		case html.StartTagToken, html.SelfClosingTagToken:
			// TagName and TagAttr return slices into the tokenizer's
			// buffer, valid only until the next call to Next. Nothing
			// is allocated unless the tag is an <a> with an href.
			name, hasAttr := z.TagName()
			if !hasAttr || len(name) != 1 || name[0] != 'a' {
				continue
			}
			for more := true; more; {
				var key, val []byte
				key, val, more = z.TagAttr()
				if string(key) != "href" {
					continue
				}
				s, err := Normalize(base, string(val))
				if err != nil || seen[s] {
					break
				}
				seen[s] = true
				links = append(links, s)
				break // like a browser, use the first href only
			}
		}
	}
}
```

The tokenizer reads the page as a stream of tokens and keeps nothing. `TagName` and `TagAttr` return byte slices into the tokenizer's own buffer, so a `<p>` or a run of text costs no allocation at all, and only an `<a href>` reaches `Normalize`. The existing `TestLinks` table from step 6, including the broken-markup case, passes unchanged: the test is what makes this rewrite safe.

`string(key) != "href"` does not allocate: the compiler recognises a conversion used only for a comparison. `-gcflags=-m` confirms it, and shows the allocations that remain are the ones the result needs:

```bash
go build -gcflags=-m ./internal/crawl 2>&1 | grep links.go
```

```text
internal\crawl/links.go:20:24: inlining call to html.NewTokenizer
internal\crawl/links.go:26:19: inlining call to html.(*Tokenizer).Err
internal\crawl/links.go:19:12: leaking param content: base
internal\crawl/links.go:19:27: leaking param: r
internal\crawl/links.go:22:14: make(map[string]bool) does not escape
internal\crawl/links.go:41:15: string(key) does not escape
internal\crawl/links.go:44:38: string(val) escapes to heap
internal\crawl/links.go:49:19: append escapes to heap
```

The `seen` map does not escape, so the compiler can keep it on the stack; the `href` string and the result slice escape, because they outlive the call.

### Measure again

```bash
go test -run '^$' -bench Links -count 10 ./internal/crawl > after.txt
go run golang.org/x/perf/cmd/benchstat@latest before.txt after.txt
```

```text
goos: windows
goarch: amd64
pkg: example.com/linkcheck/internal/crawl
cpu: 13th Gen Intel(R) Core(TM) i7-1355U
         │  before.txt  │              after.txt              │
         │    sec/op    │    sec/op     vs base               │
Links-12   4.336m ± 26%   3.976m ± 20%  -8.32% (p=0.007 n=10)

         │  before.txt   │              after.txt               │
         │      B/s      │      B/s       vs base               │
Links-12   34.07Mi ± 21%   37.18Mi ± 25%  +9.14% (p=0.007 n=10)

         │  before.txt  │              after.txt               │
         │     B/op     │     B/op      vs base                │
Links-12   2.652Mi ± 0%   1.243Mi ± 0%  -53.14% (p=0.000 n=10)

         │ before.txt  │              after.txt              │
         │  allocs/op  │  allocs/op   vs base                │
Links-12   52.43k ± 0%   26.79k ± 0%  -48.91% (p=0.000 n=10)
```

Bytes and allocations per page halved, exactly and every time (`± 0%`). Time improved by only 8%, with ±20% noise on a laptop. On twelve CPUs most of the garbage collector's work runs on idle cores, in parallel with the benchmark, so the wall-clock cost of the extra garbage is hidden. Give the benchmark one CPU and the collector has to take turns with it:

```bash
go test -run '^$' -bench Links -cpu 1 -count 10 ./internal/crawl
```

With the same before and after files made at `-cpu 1`, `benchstat` prints:

```text
      │ before1.txt  │              after1.txt              │
      │    sec/op    │    sec/op     vs base                │
Links   4.942m ± 11%   3.420m ± 25%  -30.80% (p=0.000 n=10)
```

31% faster. A crawler's workers parse pages on every core at once, so in a real crawl the collector does not get idle cores for free; halving the garbage is the change that scales.

The new profile shows what is left: `net/url.parse` and `ResolveReference` inside `Normalize` now lead the allocations, followed by `bytes.Replace`, which the tokenizer's `TagName` and `TagAttr` use to copy names and values. Both are the price of a correct URL and are left alone.

```text
      flat  flat%   sum%        cum   cum%
  639.59MB 38.70% 38.70%   639.59MB 38.70%  net/url.parse
  360.55MB 21.82% 60.51%   396.55MB 23.99%  net/url.(*URL).ResolveReference
  263.44MB 15.94% 76.45%  1645.60MB 99.57%  example.com/linkcheck/internal/crawl.Links
  139.50MB  8.44% 84.90%   139.50MB  8.44%  bytes.Replace
     111MB  6.72% 91.61%      111MB  6.72%  internal/bytealg.MakeNoZero
      36MB  2.18% 93.79%       36MB  2.18%  net/url.resolvePath
```

### Leaks

```go title="internal/crawl/leak_test.go"
package crawl

import (
	"bytes"
	"context"
	"errors"
	"runtime/pprof"
	"testing"
	"time"
)

// TestCancelledCrawlLeaksNoGoroutines runs a real-time crawl, cancels it
// while every worker is busy, and asks the runtime for leaked goroutines:
// ones blocked on a channel or lock that nothing can ever reach again.
func TestCancelledCrawlLeaksNoGoroutines(t *testing.T) {
	pages := map[string]fakePage{"http://site.test/": {html: `
		<a href="/1">1</a><a href="/2">2</a><a href="/3">3</a>
		<a href="/4">4</a><a href="/5">5</a><a href="/6">6</a>`}}
	for _, p := range []string{"/1", "/2", "/3", "/4", "/5", "/6"} {
		pages["http://site.test"+p] = fakePage{delay: time.Hour}
	}
	c := &Crawler{Fetcher: newFake(t, pages), MaxDepth: 1, Workers: 4}

	ctx, cancel := context.WithTimeout(t.Context(), 50*time.Millisecond)
	defer cancel()
	if _, err := c.Run(ctx, "http://site.test/"); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("err = %v, want context.DeadlineExceeded", err)
	}

	// Writing the profile runs the leak detection (it needs a GC cycle).
	var buf bytes.Buffer
	if err := pprof.Lookup("goroutineleak").WriteTo(&buf, 1); err != nil {
		t.Fatal(err)
	}
	if !bytes.HasPrefix(buf.Bytes(), []byte("goroutineleak profile: total 0\n")) {
		t.Errorf("leaked goroutines:\n%s", &buf)
	}
}
```

This test runs in real time, outside synctest, and cancels the crawl while all four workers are blocked in slow fetches. The `goroutineleak` profile, generally available since Go 1.27, uses the garbage collector to find goroutines blocked on a channel, mutex or condition variable that no running goroutine can reach any more: by definition they can never wake up. Writing the profile triggers the detection, which is why the test calls `WriteTo` and reads the count from the output.

To see it catch something, delete both the `case <-ctx.Done(): return` in the worker and the `wg.Wait()` after the loop, so `Run` returns without waiting and the workers are left sending on a channel nobody reads:

```text
--- FAIL: TestCancelledCrawlLeaksNoGoroutines (0.05s)
    leak_test.go:36: leaked goroutines:
        goroutineleak profile: total 4
        4 @ 0x7ff77a31928a 0x7ff77a2a54fc 0x7ff77a2a50f7 0x7ff77a65b89f 0x7ff77a32956a 0x7ff77a320721
        #	0x7ff77a65b89e	example.com/linkcheck/internal/crawl.(*Crawler).Resume.func1+0x11e	C:/Users/Pratam/AppData/Local/Temp/leak2/internal/crawl/crawler.go:130
        #	0x7ff77a329569	sync.(*WaitGroup).Go.func1+0x49						C:/Users/Pratam/go/pkg/mod/golang.org/toolchain@v0.0.1-go1.27.1.windows-amd64/src/sync/waitgroup.go:258
```

All four workers, at the send in `Resume`. The synctest test from step 6 catches the version where only the `select` case is missing (`wg.Wait` then hangs); this one catches the version where nothing hangs and goroutines quietly pile up.

### Live profiles

```go title="pprof.go"
package main

import (
	"fmt"
	"io"
	"net"
	"net/http"
	_ "net/http/pprof" // registers /debug/pprof/ on http.DefaultServeMux
)

// startPprof serves the runtime profiles on addr for as long as the
// process runs. Only the profiling endpoints are on DefaultServeMux; the
// report server in serve.go uses its own mux, so they never mix.
func startPprof(addr string, stderr io.Writer) error {
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		return err
	}
	fmt.Fprintf(stderr, "profiles on http://%s/debug/pprof/\n", ln.Addr())
	go http.Serve(ln, nil)
	return nil
}
```

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
}

func main() {
	cfg := config{rate: rateFlag{n: 10, per: time.Second}}
	flag.IntVar(&cfg.depth, "depth", 3, "follow links up to `n` clicks from the start page")
	flag.IntVar(&cfg.workers, "workers", 8, "check up to `n` links at once")
	flag.BoolVar(&cfg.verbose, "v", false, "log every check to stderr")
	flag.Var(&cfg.rate, "rate", "at most `N/PERIOD` requests to each host, such as 10/s or 30/m; 0 for no limit")
	flag.DurationVar(&cfg.timeout, "timeout", 10*time.Second, "give up on a request after `d`")
	flag.BoolVar(&cfg.checkTCP, "check-tcp", false, "connect to each start host before crawling")
	flag.StringVar(&cfg.userAgent, "user-agent", "linkcheck/dev", "User-Agent header to send")
	flag.Var(&cfg.include, "include", "only check links matching `regexp` (repeatable)")
	flag.Var(&cfg.exclude, "exclude", "skip links matching `regexp` (repeatable)")
	flag.StringVar(&cfg.format, "format", "text", "report `format`: text, json, csv, junit or html")
	flag.StringVar(&cfg.out, "out", "", "write the report to `file` instead of stdout")
	flag.StringVar(&cfg.serve, "serve", "", "after the crawl, serve the HTML report on `addr`, such as 127.0.0.1:8090")
	flag.StringVar(&cfg.stateFile, "state", "", "resume from `file` if it exists; save to it when interrupted")
	flag.StringVar(&cfg.pprofAddr, "pprof", "", "serve runtime profiles on `addr`, such as 127.0.0.1:6060")
	configPath := flag.String("config", "", "read settings from the JSON `file`; flags win")
	flag.Usage = func() {
		fmt.Fprintln(flag.CommandLine.Output(), "usage: linkcheck [flags] URL...")
		flag.PrintDefaults()
	}
	flag.Parse()
	cfg.starts = flag.Args()
	if *configPath != "" {
		set := make(map[string]bool)
		flag.Visit(func(f *flag.Flag) { set[f.Name] = true })
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
	if err := writeReport(reporter, rep, cfg.out, stdout); err != nil {
		fmt.Fprintf(stderr, "linkcheck: %v\n", err)
		return exitError
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

// writeReport writes the report to the file at path, or to stdout when
// path is empty.
func writeReport(reporter report.Reporter, rep *report.Report, path string, stdout io.Writer) (err error) {
	if path == "" {
		return reporter.Report(stdout, rep)
	}
	f, err := os.Create(path)
	if err != nil {
		return err
	}
	// A write error can surface only at Close, so its error must not be
	// dropped: keep it unless an earlier error is already being returned.
	defer func() {
		if cerr := f.Close(); err == nil {
			err = cerr
		}
	}()
	return reporter.Report(f, rep)
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

The blank import `_ "net/http/pprof"` runs the package's `init`, which registers its handlers on `http.DefaultServeMux`. That is why the report server from step 7 uses a mux of its own: profiles stay off the report port.

## Run it

```bash
go test -count=1 ./...
```

```text
ok  	example.com/linkcheck	0.567s
?   	example.com/linkcheck/cmd/testsite	[no test files]
ok  	example.com/linkcheck/internal/crawl	0.888s
ok  	example.com/linkcheck/internal/report	0.593s
ok  	example.com/linkcheck/internal/state	0.498s
```

With the testsite running, start a crawl with profiles on, and while `/slow` holds it open, ask for the leak and goroutine profiles from a second terminal:

```bash
go build .
./linkcheck -pprof 127.0.0.1:6060 http://127.0.0.1:8080/
```

```bash
curl -s "http://127.0.0.1:6060/debug/pprof/goroutineleak?debug=1" | head -3
curl -s "http://127.0.0.1:6060/debug/pprof/goroutine?debug=1" | head -1
```

```text
goroutineleak profile: total 0
goroutine profile: total 20
```

Twenty goroutines are alive (workers, the HTTP transport's connection readers and writers, the pprof server), and none of them is leaked. `go tool pprof http://127.0.0.1:6060/debug/pprof/profile?seconds=10` records a CPU profile of a long crawl the same way.

> [!WARNING]
> Do not optimise from a single benchmark run. The first two "before" runs above differ by 18% with no code change. Run at least `-count 6`, compare with `benchstat`, and trust the allocation columns (which are exact) more than the time column on a laptop that changes clock speed under load.

The tool is fast, tested and complete. [[step-10-ship]] turns it into a versioned binary for every platform.
