---
title: Build information
done_when: "Your program prints its version, Go version, commit and dependencies, and you can say which values come from the go command and which from -ldflags."
---
A binary you shipped last month needs to answer "which version are you?" when something breaks. Go helps in two ways. The `go` command records facts about every build inside the binary, and `runtime/debug.ReadBuildInfo` reads them back. For anything else (a release number you choose), you inject a string at link time with `-ldflags -X`.

## Reading the recorded build information

```go title="main.go"
package main

import (
	"fmt"
	"os"
	"runtime/debug"

	"golang.org/x/text/language"
)

// version is set at build time: go build -ldflags "-X main.version=v1.2.3"
var version = "dev"

func main() {
	fmt.Println("language tag:", language.English)
	info, ok := debug.ReadBuildInfo()
	if !ok {
		fmt.Println("no build info (built without module support)")
		os.Exit(1)
	}
	fmt.Println("version (ldflags):", version)
	fmt.Println("go version:       ", info.GoVersion)
	fmt.Println("main module:      ", info.Main.Path, info.Main.Version)
	fmt.Println("package:          ", info.Path)

	// Settings is a list of key/value pairs recorded by the go command.
	for _, s := range info.Settings {
		switch s.Key {
		case "-ldflags", "-trimpath", "CGO_ENABLED", "GOARCH", "GOOS", "GOAMD64",
			"vcs", "vcs.revision", "vcs.time", "vcs.modified":
			fmt.Printf("  %-13s %s\n", s.Key, s.Value)
		}
	}

	fmt.Println("dependencies:", len(info.Deps))
	for _, d := range info.Deps {
		fmt.Println(" ", d.Path, d.Version)
	}
}
```

The program imports `golang.org/x/text/language` only so there is a dependency to list. Set it up in a folder that is a Git repository with at least one commit:

```bash
git init
go mod init example.com/buildinfo
go get golang.org/x/text@v0.20.0
go mod tidy
git add -A && git commit -m init
```

Run it two ways. `go run` builds a temporary binary; `go build` makes a real one:

```bash
go run .
go build -o app . && ./app
```

```text
language tag: en
version (ldflags): dev
go version:        go1.27.1
main module:       example.com/buildinfo (devel)
package:           example.com/buildinfo
  CGO_ENABLED   1
  GOARCH        amd64
  GOOS          windows
  GOAMD64       v1
dependencies: 1
  golang.org/x/text v0.20.0
```

```text
language tag: en
version (ldflags): dev
go version:        go1.27.1
main module:       example.com/buildinfo v0.0.0-20261003135031-98868512d6b1
package:           example.com/buildinfo
  CGO_ENABLED   1
  GOARCH        amd64
  GOOS          windows
  GOAMD64       v1
  vcs           git
  vcs.revision  98868512d6b18b57361d6d69d32ba91e24ff9355
  vcs.time      2026-10-03T13:50:31Z
  vcs.modified  false
dependencies: 1
  golang.org/x/text v0.20.0
```

Your commit hash, time and platform values differ. Now change a file without committing, stamp a version and trim paths, then ask the `go` command to list what it recorded:

```bash
go build -ldflags "-X main.version=v1.2.3" -trimpath -o app2 .
./app2 | grep -E "version \(|modified|trimpath"
go version -m app2
```

```text
version (ldflags): v1.2.3
  -trimpath     true
  vcs.modified  true
```

```text
app2: go1.27.1
	path	example.com/buildinfo
	mod	example.com/buildinfo	v0.0.0-20261003135031-98868512d6b1+dirty	
	dep	golang.org/x/text	v0.20.0	h1:gK/Kv2otX8gz+wn7Rmb3vT96ZwuoxnQlY+HlJVj7Qug=
	build	-buildmode=exe
	build	-compiler=gc
	build	-trimpath=true
	build	CGO_ENABLED=1
	build	GOARCH=amd64
	build	GOOS=windows
	build	GOAMD64=v1
	build	vcs=git
	build	vcs.revision=98868512d6b18b57361d6d69d32ba91e24ff9355
	build	vcs.time=2026-10-03T13:50:31Z
	build	vcs.modified=true
```

`go version -m file` prints the same data for any Go binary, including ones you did not build, without running them.

## How it works

**`debug.ReadBuildInfo()` returns a `*debug.BuildInfo`** with these fields:

| Field | Holds |
|---|---|
| `GoVersion` | the toolchain that built the binary, `go1.27.1` |
| `Path` | the import path of the main package |
| `Main` | the main module: `Path`, `Version` and a `Sum` |
| `Deps` | every dependency module linked in, with its version |
| `Settings` | build settings as `Key`/`Value` pairs |

The boolean result is false when the binary was built without module information, which is rare today.

**`Main.Version` has three possible forms.** `go run` printed `(devel)`: the go command does not stamp a version when it runs a program. `go build` inside a Git checkout stamped a pseudo-version built from the commit time and hash (`v0.0.0-<time>-<hash>`), and it adds `+dirty` when the working tree has uncommitted changes. A binary installed with `go install example.com/tool@v1.4.0` carries `v1.4.0`, the real module version. A binary built from a Git checkout is not at a tag, so for a release number you choose, use `-ldflags`.

**VCS settings.** When the main package is in a Git or Mercurial repository, `go build` records `vcs`, `vcs.revision` (the commit), `vcs.time` and `vcs.modified` (true when files differ from the commit). This is what lets you map a binary back to its source. By default (`-buildvcs=auto`) the information is stamped only when the main package, its module and the current directory are all in the same repository; `go build -buildvcs=false` omits it always, which is useful in container builds where the `.git` directory is not copied in. `go run` never records them.

**`-ldflags -X` injects a string.** `-X main.version=v1.2.3` sets the package-level string variable `version` in package `main` before the program starts. It works only on a `string` variable, not a constant and not an initialised-by-function value, and the path is the full import path of the package (`-X example.com/buildinfo/internal/ver.Version=1.2`). The variable's default (`"dev"`) is what a normal `go build` shows. Cross-compiling and stamping from the build script are covered in [[cross-compile]].

**`-trimpath`** removes your local directory names from the binary, so builds are reproducible across machines and stack traces do not reveal them. It is recorded as a build setting, as shown.

A program can then answer the question with one flag. A common design: print the injected version if it is set, otherwise fall back to the build information:

```go
func versionString() string {
	if version != "dev" {
		return version
	}
	if info, ok := debug.ReadBuildInfo(); ok && info.Main.Version != "" {
		return info.Main.Version
	}
	return "unknown"
}
```

> [!WARNING]
> A binary built with `go run`, or in a directory that is not a repository, has no commit information, and a binary built from a dirty tree says `+dirty` or `vcs.modified=true`. Symptom: a bug report with `(devel)` as the version, which you cannot trace to a commit. Fix: build releases from a clean checkout of a tag with `go build`, stamp the tag with `-ldflags -X`, and make `--version` print it together with `vcs.revision`.

> [!NOTE]
> `-ldflags "-s -w"` strips the symbol table and DWARF debug data to shrink the binary. The build information and `-X` values are kept. Stripped binaries have less useful stack traces for debuggers, not for panics: panic traces still show function names and lines.

linkcheck reports its version from `debug.ReadBuildInfo` and an `-ldflags` value, and prints it for `--version`, in [[step-10-ship]].
