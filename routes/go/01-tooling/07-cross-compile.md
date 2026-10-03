---
title: Cross-compiling and stamping versions
done_when: "One command per target builds Linux, macOS and Windows binaries from your machine, each prints the version you passed with -ldflags, and `go version -m` on any of them shows the git revision it was built from."
---
**Cross-compiling** means building a binary for a different operating system or CPU than
the one you are on. In most languages that needs a separate toolchain per target. Go's
compiler and linker support every target out of the box, and the standard library is
compiled from source, so building a Linux ARM binary on a Windows laptop is two environment
variables. **Stamping** means recording in the binary which version it is and what it was
built from, so that a binary found on a server can tell you where it came from.

## Building for four targets

```go title="main.go"
package main

import (
	"fmt"
	"runtime"
)

// version is replaced at link time with -ldflags "-X main.version=...".
var version = "dev"

func main() {
	fmt.Printf("hello %s (%s/%s, %s)\n", version, runtime.GOOS, runtime.GOARCH, runtime.Version())
}
```

The module is a git repository with one commit, tagged `v1.2.0`. Build for four targets:

```bash
for t in linux/amd64 linux/arm64 darwin/arm64 windows/amd64; do
  os=${t%/*}; arch=${t#*/}; ext=""
  [ "$os" = windows ] && ext=.exe
  CGO_ENABLED=0 GOOS=$os GOARCH=$arch \
    go build -trimpath -ldflags="-s -w -X main.version=v1.2.0" -o dist/hello-$os-$arch$ext .
done
go version dist/*
./dist/hello-windows-amd64.exe
```

```text
dist/hello-darwin-arm64: go1.27.1
dist/hello-linux-amd64: go1.27.1
dist/hello-linux-arm64: go1.27.1
dist/hello-windows-amd64.exe: go1.27.1
hello v1.2.0 (windows/amd64, go1.27.1)
```

Each file in `dist/` is a complete, statically linked program for its target. Copy
`hello-linux-arm64` to a Raspberry Pi and it runs; nothing needs to be installed there.

## How it works: GOOS, GOARCH and cgo

`GOOS` and `GOARCH` pick the target. They default to your machine (`go env GOOS GOARCH`).
`go tool dist list` prints every supported pair; Go 1.27.1 knows 47, including:

```text
darwin/amd64 darwin/arm64 linux/386 linux/amd64 linux/arm linux/arm64 linux/loong64 linux/mips linux/mips64 linux/mips64le linux/mipsle linux/ppc64 linux/ppc64le linux/riscv64 linux/s390x windows/386 windows/amd64 windows/arm64
```

Changing `GOOS` also changes which files are compiled, by exactly the rules in
[[build-tags]].

The one thing that does not cross-compile freely is **cgo**, Go's mechanism for calling C.
A package that uses cgo needs a C compiler for the target. `CGO_ENABLED` controls it: it
defaults to `1` for native builds when a C compiler is found, and to `0` when cross-compiling:

```bash
go env CGO_ENABLED
GOOS=linux go env CGO_ENABLED
```

```text
1
0
```

With cgo off, packages such as `net` and `os/user` use their pure-Go implementations and the
binary has no dependency on the system C library. Setting `CGO_ENABLED=0` explicitly, even
for native builds, gives you the same fully static binary on every target, which is what you
want for containers and for download pages.

## How it works: the flags

| Flag | Effect |
|---|---|
| `-o path` | Output file. With `GOOS=windows`, add `.exe` yourself |
| `-ldflags="-X importpath.name=value"` | Linker sets a package-level `string` variable before the program starts |
| `-ldflags="-s -w"` | Omit the symbol table (`-s`) and DWARF debug info (`-w`): smaller binary, no debugger symbols |
| `-trimpath` | Remove your machine's file paths from the binary, so stack traces show module paths and builds are reproducible across machines |
| `-buildvcs=false` | Do not record version control information |

`-s -w` matters: the same Linux build is 2,376,075 bytes without them and 1,519,776 bytes
with them. Panics still print stack traces, because those use a different table that is
always kept.

`-X` has a strict form: the full import path of the package, a dot, the variable name. For
package `main` the path is `main`. The variable must be a `string` variable (not a constant)
that is uninitialised or initialised to a constant string; `-X` does nothing if the
initialiser calls a function or refers to another variable.

## How it works: what Go records by itself

Since Go 1.18, `go build` embeds **build information** in every binary: the toolchain, the
module path and version, every dependency with its version and checksum, the build flags,
and the version control state. `go version -m` reads it from any Go binary, for any
platform:

```bash
go version -m dist/hello-linux-arm64
```

```text
dist/hello-linux-arm64: go1.27.1
	path	example.com/hello
	mod	example.com/hello	v1.2.0	
	build	-buildmode=exe
	build	-compiler=gc
	build	-trimpath=true
	build	CGO_ENABLED=0
	build	GOARCH=arm64
	build	GOOS=linux
	build	GOARM64=v8.0
	build	vcs=git
	build	vcs.revision=2542bd811aabd311489330cea7b4e284e9af223b
	build	vcs.time=2026-10-03T08:43:15Z
	build	vcs.modified=false
```

The `mod` line has version `v1.2.0` although nobody passed it: since Go 1.24, `go build`
derives the main module's version from the git tag on the current commit. The other cases:

| Repository state | Recorded main module version |
|---|---|
| Commit tagged `v1.2.0`, clean tree | `v1.2.0` |
| Same commit, uncommitted edits | `v1.2.0+dirty`, and `vcs.modified=true` |
| One commit after the tag | A pseudo-version: `v1.2.1-0.20261003084403-337379e12994` |
| `-buildvcs=false`, or not a repository | `(devel)` |

A build without `-trimpath` also records the `-ldflags` value
(`build	-ldflags="-X main.version=v1.2.0"`); in the `-trimpath` build above it is left out.

So you get two ways to stamp a version: `-X`, which puts any string you like into a
variable, and the automatic VCS stamp, which the program can read at run time with
`debug.ReadBuildInfo` (taught in [[build-info]]). Use the automatic stamp for "which commit
is this" and `-X` when your release process decides the version string.

> [!WARNING]
> `-X` fails silently when the name does not match. `go run -ldflags="-X main.Version=v1.2.0" .`
> builds fine and prints `hello dev`, because there is no `main.Version` (the variable is
> lower-case `version`). Leave out the package (`-X version=v1.2.0`) and the linker does
> complain: `-X flag requires argument of the form importpath.name=value`. Check a release
> build by running it with a `--version` flag in CI, not by reading the build script.

> [!NOTE]
> Programs that build their release artefacts from a script often use the same loop as
> above. `go tool dist list -json` adds which targets are first-class ports and which
> support cgo. The full list of build flags is in `go help build`.

linkcheck prints its version from both sources, `-ldflags` and `debug.ReadBuildInfo`, and
is cross-compiled for three operating systems in [[step-10-ship]].
