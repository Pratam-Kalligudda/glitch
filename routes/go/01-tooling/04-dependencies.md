---
title: Adding, upgrading and tidying dependencies
done_when: "You can upgrade one dependency to its latest patch, roll back an upgrade that broke behaviour, and develop against a local copy of a module with a workspace, without hand-editing go.mod."
---
Because minimal version selection never picks a newer version on its own (see
[[modules]]), every upgrade in Go is a command you run. That is good for reproducibility
and bad if you never run it. This stop covers the commands that change your dependency set,
what each one changes, and how to undo an upgrade that went wrong.

Three commands do nearly all the work:

| Command | Job |
|---|---|
| `go get` | Change the requirement on one module: add, upgrade, downgrade, remove |
| `go mod tidy` | Make go.mod and go.sum match the imports in your code: add what is missing, drop what is unused |
| `go list -m` | Read the build list and the available versions without changing anything |

## Seeing what is out of date

Start from a module that requires `rsc.io/quote` v1.5.1, one patch behind:

```bash
go get rsc.io/quote@v1.5.1
go mod tidy
go list -m -u all
```

```text
go: downloading rsc.io/quote v1.5.1
go: added golang.org/x/text v0.0.0-20170915032832-14c0d48ead0c
go: added rsc.io/quote v1.5.1
go: added rsc.io/sampler v1.3.0
example.com/quotes
golang.org/x/text v0.0.0-20170915032832-14c0d48ead0c [v0.42.0]
rsc.io/quote v1.5.1 [v1.5.2]
rsc.io/sampler v1.3.0 [v1.99.99]
```

`-u` adds the newest available version in brackets. Nothing changed yet.

## Upgrading, from narrow to wide

```bash
go get -u=patch rsc.io/quote
```

```text
go: upgraded rsc.io/quote v1.5.1 => v1.5.2
go: upgraded rsc.io/sampler v1.3.0 => v1.3.1
```

`-u=patch` moved quote to its latest patch and also the dependencies of quote to their
latest patches. `go get rsc.io/quote@latest` would now print nothing: v1.5.2 already is the
latest. Now the wide upgrade, every dependency of every package in the module:

```bash
go get -u ./...
go run .
```

```text
go: downloading rsc.io/sampler v1.99.99
go: downloading golang.org/x/text v0.42.0
go: upgraded golang.org/x/text v0.0.0-20170915032832-14c0d48ead0c => v0.42.0
go: upgraded rsc.io/sampler v1.3.1 => v1.99.99
99 bottles of beer on the wall, 99 bottles of beer, ...
```

The program still compiles, and now prints something else. `rsc.io/sampler` v1.99.99 is a
deliberately bad release that keeps the API and changes behaviour, exactly what a real
dependency does by accident. Roll it back by asking for the version you want:

```bash
go get rsc.io/sampler@v1.3.1
go run .
```

```text
go: downgraded rsc.io/sampler v1.99.99 => v1.3.1
Hello, world.
```

To stop future `go get -u` runs from picking that version again, exclude it:

```bash
go mod edit -exclude=rsc.io/sampler@v1.99.99
go get -u ./...
go list -m rsc.io/sampler
```

```text
rsc.io/sampler v1.3.1
```

## How it works: what go get does

`go get module@query` sets the requirement on one module and then re-runs MVS. Any other
module whose requirements no longer fit is moved too, up or down, and every change is
printed. The query can be:

| Query | Meaning |
|---|---|
| `@v1.5.2` | Exactly that version |
| `@latest` | Highest release version (not pre-release) |
| `@upgrade` | Like `latest`, but never downgrades if you already require something newer, such as a pre-release; the default when you omit the query |
| `@patch` | Latest patch of the minor version you have now |
| `@v1.5` | Latest `v1.5.x` |
| `@4f3a2b1` / `@master` | A commit or branch, recorded as a pseudo-version |
| `@none` | Remove the requirement, downgrading anything that needs it |

The `-u` flag widens the change from "this module" to "this module and its dependencies";
`-u=patch` does the same but only within patch releases. `go get -u ./...` is the
broadest: every dependency of every package in your module. Run it on purpose, on a branch,
followed by your tests, never as a reflex.

`@none` removes a module, and MVS follows through. Removing `golang.org/x/text`, which
quote v1.5.2 needs, forces quote and sampler down to versions that do not need it:

```bash
go get golang.org/x/text@none
```

```text
go: downloading rsc.io/sampler v1.0.0
go: removed golang.org/x/text v0.42.0
go: downgraded rsc.io/quote v1.5.2 => v1.4.0
go: downgraded rsc.io/sampler v1.3.1 => v1.0.0
```

## go mod tidy

`go get` edits requirements; it does not look at whether your code still imports them.
`go mod tidy` does: it loads every package in the module, for every build tag and OS, plus
tests, adds requirements for imports nobody required yet, removes requirements no import
needs, and rewrites go.sum to match. Delete the only import of quote from `main.go`:

```go title="main.go"
package main

import "fmt"

func main() {
	fmt.Println("no dependencies")
}
```

```bash
go mod tidy
cat go.mod
```

```text
module example.com/quotes

go 1.27
```

All three requirements and every go.sum line are gone. Run `go mod tidy` before every
commit that touches imports; CI can check it with `go mod tidy -diff`, which prints the
changes it would make and exits non-zero if there are any.

`go mod verify` re-hashes the modules in your cache and compares them with go.sum, which
catches a cache someone edited by hand:

```text
all modules verified
```

## Developing against a local copy

Sometimes you need to change a dependency and your module together: fix a bug in a library
and test it in the app. There are two tools.

**replace** in go.mod points a module path at a directory:

```bash
go mod edit -replace=example.com/greet=../greet
go mod tidy
```

```text title="go.mod"
module example.com/app

go 1.27

replace example.com/greet => ../greet

require example.com/greet v0.0.0-00010101000000-000000000000
```

It works, but it lives in go.mod, so it gets committed by accident and breaks the build for
everyone who does not have `../greet`.

**A workspace** keeps that wiring out of go.mod. A `go.work` file in a parent directory
lists modules that build together, as if each were replaced by its local directory:

```bash
cd ..
go work init ./app ./greet
cat go.work
cd app
go run .
```

```text
go 1.27.1

use (
	./app
	./greet
)
hello, gopher
```

The `go` command finds `go.work` by walking up from the current directory; `go env GOWORK`
shows which one is active. `GOWORK=off` ignores it, which is what CI should see. Do not
commit `go.work` for an application repository.

## Tools as dependencies

Code generators and linters are dependencies too. Since Go 1.24 a `tool` directive records
them in go.mod, so everyone runs the same version:

```bash
go get -tool golang.org/x/tools/cmd/stringer@latest
go tool
```

```text title="go.mod"
module example.com/quotes

go 1.27

tool golang.org/x/tools/cmd/stringer

require (
	golang.org/x/mod v0.41.0 // indirect
	golang.org/x/sync v0.23.0 // indirect
	golang.org/x/tools v0.51.0 // indirect
)
```

`go tool stringer -type Level` then builds and runs that exact version. Its requirements
appear as `// indirect` because your code does not import them. The `tool` pattern names
all of a module's tools: `go get tool` upgrades them, `go install tool` installs them.

> [!WARNING]
> Running `go get -u ./...` and committing because "it compiles" is how behaviour changes
> slip in, as the sampler example shows: the API stayed the same and the output changed.
> Upgrade in small steps (`-u=patch` first), read the printed upgrade list, run the tests,
> and commit go.mod and go.sum together. If an upgrade breaks you, `go get module@oldversion`
> undoes it; `exclude` keeps it out.

> [!NOTE]
> Private modules: set `GOPRIVATE=github.com/yourcompany/*` (with `go env -w`) so the `go`
> command fetches them directly from version control instead of `proxy.golang.org` and does
> not look them up in the public checksum database. `go help private` has the details.

linkcheck adds `golang.org/x/net` with `go get` in [[step-1-single-page]], and its tests in
[[step-6-tests]] run against whatever `go mod tidy` leaves in go.mod.
