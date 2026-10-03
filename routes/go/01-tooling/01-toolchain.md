---
title: The go command and toolchains
done_when: "`go version` inside your module prints go1.27.x, and `GOTOOLCHAIN=local go build` either builds or tells you exactly which version go.mod requires."
---
Everything in Go goes through one program: `go`. It compiles, runs, tests, formats, vets,
downloads dependencies and even downloads newer versions of itself. There is no separate
build system, package manager or version manager to install. Knowing what the `go` command
does on your behalf, and which version of it actually runs, saves you from the most
confusing class of Go problems: "it builds on my machine".

A **toolchain** is one release of Go: the `go` command plus the compiler, linker and
standard library that ship with it, for example `go1.27.1`. The toolchain you installed is
the **local** toolchain. Since Go 1.21, the local `go` command can hand off to a different
toolchain when your module asks for one.

## The commands you use every day

Create a module and a program:

```bash
mkdir hello && cd hello
go mod init example.com/hello
go mod edit -go=1.27
```

```text
go: creating new go.mod: module example.com/hello
```

```go title="main.go"
package main

import (
	"fmt"
	"runtime"
)

func main() {
	fmt.Println("built with", runtime.Version())
}
```

`runtime.Version` reports the toolchain that compiled the binary, which makes it a good
probe for the rest of this stop.

```bash
go run .
go build -o hello.exe .
./hello.exe
go version hello.exe
```

```text
built with go1.27.1
built with go1.27.1
hello.exe: go1.27.1
```

The examples in this route were run on Windows, so binaries end in `.exe`. On Linux and
macOS, drop the extension.

| Command | What it does |
|---|---|
| `go run .` | Compiles the package in the current directory into a temporary (cached) binary and runs it |
| `go build .` | Compiles and writes the binary to the current directory, named after the module's last path element |
| `go build -o name .` | Same, with the output path you choose |
| `go install .` | Compiles and writes the binary to `GOBIN` (default `$GOPATH/bin`) |
| `go test ./...` | Builds and runs the tests of every package in the module; `./...` means "this directory and everything below it" |
| `go vet ./...` | Reports suspicious code; see [[vet-fmt-fix]] |
| `go env` | Prints the settings the go command uses |
| `go version` | Prints the toolchain version; `go version file` prints the version a binary was built with |
| `go doc pkg.Symbol` | Shows documentation from the command line |
| `go help topic` | The full manual: `go help build`, `go help environment`, `go help modules` |

## How it works: where things live

The `go` command keeps its state in a few directories. `go env` shows them:

```bash
go env GOVERSION GOROOT GOPATH GOMODCACHE GOBIN GOCACHE GOENV
```

```text
go1.27.1
C:\Users\Pratam\go\pkg\mod\golang.org\toolchain@v0.0.1-go1.27.1.windows-amd64
C:\Users\Pratam\go
C:\Users\Pratam\go\pkg\mod
C:\Users\Pratam\go\bin
C:\Users\Pratam\AppData\Local\go-build
C:\Users\Pratam\AppData\Roaming\go\env
```

| Variable | Meaning |
|---|---|
| `GOROOT` | Where the running toolchain lives: compiler, linker, standard library source. Here it is inside the module cache, because this toolchain was downloaded (see below) |
| `GOPATH` | Your Go workspace root, default `~/go`. Today it only holds the module cache and installed binaries; your code does not need to be inside it |
| `GOMODCACHE` | Downloaded dependencies, read-only, shared by every module on the machine |
| `GOBIN` | Where `go install` writes binaries. Empty means `$GOPATH/bin`. Put it on your `PATH` |
| `GOCACHE` | The build cache. Compiled packages are keyed by a hash of their inputs, so rebuilding unchanged code is instant |
| `GOENV` | The file that `go env -w` writes to |

`go env -w NAME=value` stores a default in the `GOENV` file so you do not have to export it
in every shell; `go env -u NAME` removes it. `go env -changed` lists everything that differs
from the default:

```bash
go env -changed
```

```text
set GOTOOLCHAIN=go1.27.1
```

That line is there because the shell running these examples set `GOTOOLCHAIN`, which is
exactly the variable the next section is about.

## Which toolchain runs

A module's `go.mod` declares the Go version it needs on its `go` line:

```text title="go.mod"
module example.com/hello

go 1.27
```

The `go` line does two jobs. It is the **minimum** toolchain that may build the module, and
it sets the **language version**: the compiler accepts only features that exist in that
version. A module that says `go 1.21` cannot use range-over-func (Go 1.23) even when a newer
compiler builds it.

When you run any `go` command inside a module, the local `go` command reads that line and
the `GOTOOLCHAIN` environment variable, then decides:

1. If `GOTOOLCHAIN=local`, it always uses itself. If the module needs a newer Go, it stops
   with an error.
2. If `GOTOOLCHAIN=auto` (the default, set in `$GOROOT/go.env`), it runs the version the
   module names: the `toolchain` line if there is one, otherwise the `go` line. If that is
   newer than itself, it finds that toolchain on your `PATH` (a program named like
   `go1.27.0`) or downloads it.
3. If `GOTOOLCHAIN` names a version, such as `go1.27.1`, it runs that version, and refuses
   to build a module that needs something newer. `go1.27.1+auto` uses that version but may
   switch upward; `path` and `+path` forms switch only to toolchains found on `PATH`, never
   download.

Here is the machine these examples ran on. Its installed Go is 1.25.5. Inside the module
that says `go 1.27`:

```bash
GOTOOLCHAIN=local go version
GOTOOLCHAIN=auto go version
GOTOOLCHAIN=local go build .
```

```text
go version go1.25.5 windows/amd64
go: downloading go1.27.0 (windows/amd64)
go version go1.27.0 windows/amd64
go: go.mod requires go >= 1.27 (running go 1.25.5; GOTOOLCHAIN=local)
```

With `auto`, Go 1.25.5 read `go 1.27`, downloaded the Go 1.27.0 toolchain and re-ran the
same command with it. `go 1.27` names the release `1.27.0`, so that is what it fetched. The
download is an ordinary module, `golang.org/toolchain`, fetched through your `GOPROXY` and
checked against the checksum database like any dependency; it lands in the module cache,
which is why `GOROOT` above points there. The next run finds it already downloaded and
prints nothing.

Outside any module there is no `go` line, so the local toolchain runs.

When the module asks for a version that does not exist yet, you see why the switch failed:

```bash
go mod edit -go=1.28
GOTOOLCHAIN=go1.27.1 go run .
GOTOOLCHAIN=go1.27.1+auto go run .
```

```text
go: go.mod requires go >= 1.28 (running go 1.27.1; GOTOOLCHAIN=go1.27.1)
go: downloading go1.28.0 (windows/amd64)
go: download go1.28.0 for windows/amd64: toolchain not available
```

## Changing the go and toolchain lines

Edit these lines with `go get`, not by hand, so that the `go` and `toolchain` lines stay
consistent with your dependencies:

```bash
go get go@1.27.0
go get toolchain@go1.27.1
cat go.mod
go get toolchain@none
```

```text
go: upgraded go 1.27 => 1.27.0
go: added toolchain go1.27.1
module example.com/hello

go 1.27.0

toolchain go1.27.1
go: removed toolchain go1.27.1
```

The `toolchain` line is a **preference**, not a requirement. It says "when someone builds
this module as the main module, use at least this toolchain", for example to pick up a
security fix in a point release. It never affects modules that depend on yours. The `go`
line is the requirement: it must be at least the highest `go` line of any dependency, and
`go get` raises it for you when you add a dependency that needs a newer Go.

`go mod edit -go=1.27` rewrites the line without any checks, which is fine in a brand new
module that has no dependencies yet.

> [!WARNING]
> A teammate runs `go build` and gets `go: go.mod requires go >= 1.27 (running go 1.25.5;
> GOTOOLCHAIN=local)`. Their machine or CI image sets `GOTOOLCHAIN=local` (common in
> distribution packages and some Docker images), so their old toolchain refuses to switch.
> Either install Go 1.27, or unset the variable so the default `auto` downloads the
> toolchain. Check with `go env GOTOOLCHAIN`. The opposite surprise also happens: with
> `auto`, a CI job silently builds with a newer toolchain than the one you installed. Run
> `go version` inside the module, not outside it, to see what really builds your code.

> [!NOTE]
> `go mod init` writes a `go` line based on the toolchain that runs it. Go 1.27.1 wrote
> `go 1.27.1` in these examples. Pin the line deliberately, as this route does with
> `go 1.27`. The full rules are in the official guide at <https://go.dev/doc/toolchain>.

Every module in this route, including the capstone `example.com/linkcheck`, starts with
`go 1.27` in its go.mod. [[step-10-ship]] reads the toolchain version back out of the
shipped binary.
