---
title: Modules, versions and minimal version selection
done_when: "You can predict the output of `go list -m all` after `go get` of a lower or higher version of a dependency, and explain each line of your go.mod and go.sum."
---
A **module** is a tree of Go packages released together under one version number. It is
defined by a `go.mod` file at its root. The first line, `module example.com/quotes`, is the
**module path**: the prefix of every import path inside it, and, for a published module,
the place the `go` command downloads it from.

Modules answer two questions every build has to settle: which versions of which
dependencies to use, and how to be sure the code you download is the code everyone else
gets. Go answers the first with an algorithm called **minimal version selection** (MVS),
and the second with `go.sum` and a public checksum database. Both are deliberately simple,
and both behave differently from npm, pip or Cargo, so it pays to know the rules.

## A module with a dependency

```bash
mkdir quotes && cd quotes
go mod init example.com/quotes
go mod edit -go=1.27
```

```go title="main.go"
package main

import (
	"fmt"

	"rsc.io/quote"
)

func main() {
	fmt.Println(quote.Hello())
}
```

Running it before you add the dependency tells you what to do:

```bash
go run .
```

```text
main.go:6:2: no required module provides package rsc.io/quote; to add it:
	go get rsc.io/quote
```

Ask for a specific version, then tidy:

```bash
go get rsc.io/quote@v1.5.2
go mod tidy
go run .
```

```text
go: downloading rsc.io/quote v1.5.2
go: downloading rsc.io/sampler v1.3.0
go: downloading golang.org/x/text v0.0.0-20170915032832-14c0d48ead0c
go: added golang.org/x/text v0.0.0-20170915032832-14c0d48ead0c
go: added rsc.io/quote v1.5.2
go: added rsc.io/sampler v1.3.0
Hello, world.
```

```text title="go.mod"
module example.com/quotes

go 1.27

require rsc.io/quote v1.5.2

require (
	golang.org/x/text v0.0.0-20170915032832-14c0d48ead0c // indirect
	rsc.io/sampler v1.3.0 // indirect
)
```

You imported one package and got three modules. `rsc.io/quote` v1.5.2 requires
`rsc.io/sampler` v1.3.0, which requires a commit of `golang.org/x/text`.

## How it works: reading go.mod

| Directive | Meaning |
|---|---|
| `module` | The module path |
| `go` | Minimum Go version and language version; see [[toolchain]] |
| `toolchain` | Preferred toolchain when this is the main module |
| `require` | A **minimum** version of another module that this module needs |
| `// indirect` | No package in this module imports that module directly; it is listed because something you import needs it |
| `replace` | Use different code for a module: a fork, or a local directory |
| `exclude` | Never use this exact version |
| `retract` | Written by a module's author: "do not use these versions of mine" |
| `tool` | A command-line tool this module depends on, run with `go tool` (Go 1.24); see [[dependencies]] |
| `godebug` | Default GODEBUG settings when this module is the main module |

Since Go 1.17, go.mod lists every module that provides a package your build uses, direct
or not. `go mod tidy` keeps two `require` blocks: direct dependencies first, `// indirect`
ones second. For modules that say `go 1.27` or later, `go mod tidy` also merges any extra
`require` blocks back into those two (Go 1.27).

Versions are **semantic versions**: `vMAJOR.MINOR.PATCH`. A new minor or patch must not
break callers; a new major may. `golang.org/x/text v0.0.0-20170915032832-14c0d48ead0c` is a
**pseudo-version**: the module had no tag at that commit, so the version is built from a
base version, the UTC commit time and the first 12 characters of the commit hash. You never
type those by hand; `go get golang.org/x/text@14c0d48` produces one.

## How it works: minimal version selection

Every `require` line states a minimum, never a maximum and never a range. To build, the
`go` command walks the requirement graph from your module and, for each module, selects the
**highest of the minimums** anyone asked for. That set is the **build list**. Nothing newer
is ever chosen just because it exists.

```bash
go mod graph
```

```text
example.com/quotes go@1.27
example.com/quotes golang.org/x/text@v0.0.0-20170915032832-14c0d48ead0c
example.com/quotes rsc.io/quote@v1.5.2
example.com/quotes rsc.io/sampler@v1.3.0
go@1.27 toolchain@go1.27
rsc.io/quote@v1.5.2 rsc.io/sampler@v1.3.0
rsc.io/sampler@v1.3.0 golang.org/x/text@v0.0.0-20170915032832-14c0d48ead0c
```

Each line is one edge: "this module at this version requires that one". `go list -m all`
prints the result of MVS, the build list:

```bash
go list -m -versions rsc.io/sampler
go get rsc.io/sampler@v1.3.1
go list -m all
```

```text
rsc.io/sampler v1.0.0 v1.2.0 v1.2.1 v1.3.0 v1.3.1 v1.99.99
go: downloading rsc.io/sampler v1.3.1
go: upgraded rsc.io/sampler v1.3.0 => v1.3.1
example.com/quotes
golang.org/x/text v0.0.0-20170915032832-14c0d48ead0c
rsc.io/quote v1.5.2
rsc.io/sampler v1.3.1
```

`v1.99.99` exists, yet nothing changed until you asked. Your go.mod now says "at least
v1.3.1", quote says "at least v1.3.0", and the highest minimum wins: v1.3.1.

Downgrading shows the other half of the rule. Ask for a sampler older than quote needs:

```bash
go get rsc.io/sampler@v1.2.1
```

```text
go: downloading rsc.io/sampler v1.2.1
go: downloading rsc.io/quote v1.4.0
go: downgraded rsc.io/quote v1.5.2 => v1.4.0
go: downgraded rsc.io/sampler v1.3.1 => v1.2.1
```

quote v1.5.2 requires sampler v1.3.0 or later, so it cannot coexist with sampler v1.2.1.
`go get` found the newest quote whose requirements fit, v1.4.0, and downgraded it too.
`go mod why -m` tells you who needs a module:

```bash
go mod why -m rsc.io/sampler
```

```text
# rsc.io/sampler
example.com/quotes
rsc.io/quote
rsc.io/sampler
```

Why this design: the build list depends only on the go.mod files in the graph, never on
what was published yesterday. Two people building the same commit get the same versions
without a lock file, and a new release of some deep dependency cannot change your build
until someone raises a minimum on purpose. The cost is that you upgrade explicitly; the
next stop, [[dependencies]], covers how.

## go.sum: proving the bytes

```text title="go.sum"
rsc.io/quote v1.5.2 h1:w5fcysjrx7yqtD/aO+QwRjYZOKnaM9Uh2b40tElTs3Y=
rsc.io/quote v1.5.2/go.mod h1:LzX7hefJvL54yjefDEDHNONDjII0t9xZLPXsUe+TKr0=
```

Each module version gets up to two lines: an `h1:` hash (SHA-256 based) of the whole module
content, and a `/go.mod` line hashing just its go.mod (all MVS needs to read for modules
whose code you do not build). The first time any machine downloads a version, the `go`
command checks the hash against `sum.golang.org`, a public append-only log, so a proxy or a
compromised repository cannot serve you different bytes than everyone else got. After that,
go.sum is the record. Commit both go.mod and go.sum.

## Major versions are different modules

A new major version may break callers, so Go treats it as a different module with a
different path: `rsc.io/quote/v3`. Both majors can be in one build, imported side by side:

```go title="main.go"
package main

import (
	"fmt"

	"rsc.io/quote"
	quotev3 "rsc.io/quote/v3"
)

func main() {
	fmt.Println(quote.Go())
	fmt.Println(quotev3.GoV3())
}
```

```bash
go mod tidy
go run .
```

```text
go: finding module for package rsc.io/quote/v3
go: finding module for package rsc.io/quote
go: downloading rsc.io/quote/v3 v3.1.0
go: found rsc.io/quote in rsc.io/quote v1.5.2
go: found rsc.io/quote/v3 in rsc.io/quote/v3 v3.1.0
Don't communicate by sharing memory, share memory by communicating.
Don't communicate by sharing memory, share memory by communicating.
```

This is the **import compatibility rule**: if an old and a new package have the same import
path, the new one must be backward compatible. v0 and v1 have no suffix. From v2 on, the
module path ends in `/vN` and so does every import.

> [!WARNING]
> Asking for a v2+ version under the v1 path fails:
> `go get rsc.io/quote@v3.1.0` prints
> `go: rsc.io/quote@v3.1.0: invalid version: module contains a go.mod file, so module path must match major version ("rsc.io/quote/v3")`.
> Fix the import path, not the version: `go get rsc.io/quote/v3@v3.1.0` and import
> `rsc.io/quote/v3`. When you publish your own v2, change the `module` line to end in
> `/v2` and update every import inside the module; tagging `v2.0.0` alone is not enough.

> [!NOTE]
> `replace` and `exclude` apply only in the main module, the one you run `go` commands in.
> In a dependency's go.mod they are ignored, so a library cannot force choices on its
> users. The full reference is <https://go.dev/ref/mod>.

linkcheck, the capstone, is the module `example.com/linkcheck`. Its first direct dependency,
`golang.org/x/net`, is added in [[step-1-single-page]]; `golang.org/x/time` and
`golang.org/x/sync` join it in [[step-4-polite]].
