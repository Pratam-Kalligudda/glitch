---
title: Packages, visibility and internal
done_when: "Your module has a cmd/ binary, a public package and an internal package, `go build ./...` passes, and you can name the error you get when another module imports the internal one."
---
A **package** is one directory of `.go` files that all start with the same `package`
clause. It is Go's unit of compilation, of naming and of encapsulation. A module (see
[[modules]]) is a tree of packages; a package's **import path** is the module path plus the
directory, so the package in `report/` of module `example.com/checker` is imported as
`example.com/checker/report`.

Go has no `public` or `private` keywords and no per-class access rules. Visibility is
decided by one rule about the first letter of a name, plus one rule about a directory
called `internal`. That is the whole access-control system, so it is worth knowing
exactly.

## A module with three packages

```text
checker/
  go.mod                      module example.com/checker
  cmd/checker/main.go         package main: the binary
  report/report.go            package report: importable by anyone
  internal/urlx/urlx.go       package urlx: importable only inside checker/
```

```go title="internal/urlx/urlx.go"
// Package urlx holds URL helpers shared by checker's packages.
package urlx

import "strings"

// Normalize lower-cases the URL and drops a trailing slash.
func Normalize(raw string) string {
	s := strings.TrimSuffix(raw, "/")
	return lower(s)
}

// lower is unexported: only code in package urlx can call it.
func lower(s string) string {
	return strings.ToLower(s)
}
```

```go title="report/report.go"
// Package report formats check results.
package report

import (
	"fmt"

	"example.com/checker/internal/urlx"
)

// Result is one checked link.
type Result struct {
	URL    string
	Status int
	note   string
}

// Line formats r as one line of text.
func Line(r Result) string {
	return fmt.Sprintf("%d %s", r.Status, urlx.Normalize(r.URL))
}
```

```go title="cmd/checker/main.go"
package main

import (
	"fmt"

	"example.com/checker/report"
)

func main() {
	r := report.Result{URL: "HTTPS://Example.com/", Status: 200}
	fmt.Println(report.Line(r))
}
```

```bash
go run ./cmd/checker
go list ./...
```

```text
200 https://example.com
example.com/checker/cmd/checker
example.com/checker/internal/urlx
example.com/checker/report
```

## How it works

**One directory, one package.** Every `.go` file in a directory (except `_test.go` files,
which may use `package report_test`) must declare the same package name. The name is what
callers write before the dot: `report.Line`. By convention it matches the last element of
the directory and is short, lower case, one word, no underscores: `report`, not
`reportUtils`. Callers read `report.Line`, so do not repeat the package name in exported
names (`report.ReportLine` stutters).

**`package main` makes a binary.** A package named `main` with a `func main()` builds to an
executable; any other name builds a library. A module can have several binaries; putting
each in `cmd/<name>/` keeps them apart and gives `go install` a sensible binary name.

**Exported means capitalised.** An identifier is exported, visible to other packages, when
its first character is an upper-case letter: `Result`, `URL`, `Line`, `Normalize`. Anything
else is visible only inside its own package: `lower`, `note`. The rule applies to every
kind of name: types, functions, methods, struct fields, constants, variables. Visibility
is per package, not per file or per type: any file in `report` can touch `note` on any
`Result`.

Try to set the unexported field from `main`:

```go
r := report.Result{URL: "https://example.com", Status: 200, note: "ok"}
```

```text
# example.com/checker/cmd/checker
cmd\checker\main.go:10:63: cannot refer to unexported field note in struct literal of type report.Result
```

**`internal` limits importers by directory.** A package whose path contains an element
named `internal` can be imported only by code rooted at the parent of that `internal`
directory. `example.com/checker/internal/urlx` is importable by anything under
`example.com/checker/`, and by nothing else. Another module that tries:

```go title="main.go (module example.com/other)"
package main

import (
	"fmt"

	"example.com/checker/internal/urlx"
)

func main() {
	fmt.Println(urlx.Normalize("HTTPS://Example.com/"))
}
```

```text
package example.com/other
	main.go:6:2: use of internal package example.com/checker/internal/urlx not allowed
```

Exported names in an internal package are a promise to your own packages only. You can
rename or delete them without breaking anyone, which is why most application code belongs
under `internal/` and only deliberate APIs live outside it.

**Imports form a graph without cycles.** If `report` imports `urlx`, then `urlx` may not
import `report`, directly or through other packages. The compiler rejects the cycle and
prints the path around it:

```text
package example.com/checker/cmd/checker
	imports example.com/checker/report from main.go
	imports example.com/checker/internal/urlx from report.go
	imports example.com/checker/report from cycle.go: import cycle not allowed
```

The fix is structural: move the shared piece into a third package both can import, or have
the lower package accept an interface instead of importing the higher one (you will see
that pattern in [[accept-interfaces]]).

## Package initialisation

Before `main` runs, every package is initialised exactly once, in dependency order: a
package's imports are fully initialised before it is. Inside a package, package-level
variables are initialised in dependency order (not file order), then each `init`
function runs in the order it appears. A package may have several `init` functions.

```go title="config/config.go"
package config

import "fmt"

// Default is set before any package that imports config runs.
var Default = load()

func load() string {
	fmt.Println("config: load")
	return "default"
}

func init() {
	fmt.Println("config: init")
}
```

```go title="main.go"
package main

import (
	"fmt"

	"example.com/initorder/config"
)

var b = a + 1 // declared first, initialized second: it depends on a
var a = start()

func start() int {
	fmt.Println("main: var a, config is", config.Default)
	return 1
}

func init() {
	fmt.Println("main: init 1, b =", b)
}

func init() {
	fmt.Println("main: init 2")
}

func main() {
	fmt.Println("main: main")
}
```

```bash
go run .
```

```text
config: load
config: init
main: var a, config is default
main: init 1, b = 2
main: init 2
main: main
```

> [!WARNING]
> Doing real work in `init`, such as reading files, opening connections or parsing
> flags, makes a package impossible to import without side effects. The symptom is a test
> that fails or hangs before any test function runs, or a tool that crashes on `--help`.
> Keep `init` to cheap, infallible setup (registering a codec, filling a lookup table);
> do anything that can fail in a function that returns an error and call it from `main`.

| Rule | Effect |
|---|---|
| Upper-case first letter | Exported: visible to importers |
| Lower-case or `_` first letter | Visible only inside the package |
| Path element `internal` | Importable only from the tree rooted at its parent |
| `package main` + `func main()` | Builds an executable |
| Directory `testdata` or name starting with `.` or `_` | Ignored by `./...` patterns |
| Import cycle | Compile error; restructure |

The capstone, `example.com/linkcheck`, starts as a single `main` package in
[[step-1-single-page]]; when it grows, these rules decide what goes where.
