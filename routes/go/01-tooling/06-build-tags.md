---
title: Build constraints and per-OS files
done_when: "`GOOS=linux go list -f '{{.GoFiles}}' .` and `GOOS=windows go list -f '{{.GoFiles}}' .` list different files, and both `go build` and `go build -tags debug` succeed."
---
Some code only makes sense on one platform: the command that opens a browser is `open` on
macOS, `xdg-open` on Linux and something else again on Windows. Some code should only be in
some builds: extra logging in a debug build, an integration test that needs a database.
Go handles both without `#ifdef`: each **file** is either in the build or out of it, decided
by its name and by a **build constraint** comment at its top. A build constraint is also
called a **build tag**.

## Choosing files per OS, and per build

The program prints the command it would use to open a report:

```go title="main.go"
package main

import (
	"fmt"
	"os"
)

func main() {
	fmt.Println("open with:", openCommand())
	if debug {
		fmt.Println("debug build")
	}
	if len(os.Args) > 1 {
		fmt.Println("target:", os.Args[1])
	}
}
```

`openCommand` has three definitions, one per file:

```go title="open_windows.go"
package main

func openCommand() string { return "rundll32 url.dll,FileProtocolHandler" }
```

```go title="open_darwin.go"
package main

func openCommand() string { return "open" }
```

```go title="open_unix.go"
//go:build unix && !darwin

package main

func openCommand() string { return "xdg-open" }
```

`debug` has two:

```go title="debug_on.go"
//go:build debug

package main

const debug = true
```

```go title="debug_off.go"
//go:build !debug

package main

const debug = false
```

```bash
go run . report.html
go run -tags debug .
```

```text
open with: rundll32 url.dll,FileProtocolHandler
target: report.html
open with: rundll32 url.dll,FileProtocolHandler
debug build
```

This ran on Windows. To see what any platform would compile, set `GOOS` and ask
`go list`, which evaluates the constraints without building:

```bash
for os in windows darwin linux freebsd; do
  echo "$os: $(GOOS=$os go list -f '{{.GoFiles}}' .)"
done
GOOS=linux go list -tags debug -f '{{.GoFiles}} ignored: {{.IgnoredGoFiles}}' .
```

```text
windows: [debug_off.go main.go open_windows.go]
darwin: [debug_off.go main.go open_darwin.go]
linux: [debug_off.go main.go open_unix.go]
freebsd: [debug_off.go main.go open_unix.go]
[debug_on.go main.go open_unix.go] ignored: [debug_off.go open_darwin.go open_windows.go]
```

## How it works

For every file, the `go` command checks two things. Both must allow the file.

**The file name.** After removing `.go` and an optional `_test` suffix, a name ending in
`_GOOS`, `_GOARCH` or `_GOOS_GOARCH` (with real values, such as `_windows`, `_arm64`,
`_linux_amd64`) carries an implicit constraint. `open_windows.go` is built only when
`GOOS=windows`. A name like `open_unix.go` has no effect, because `unix` is not a `GOOS`
value; that file needs an explicit constraint.

**The `//go:build` line.** It is a boolean expression over tags with `&&`, `||`, `!` and
parentheses, with Go's precedence. It must come before the `package` clause, preceded only
by blank lines and other comments, and be followed by a blank line so it is not mistaken for
package documentation. One `//go:build` line per file.

The tags that are true during a build:

| Tag | True when |
|---|---|
| `linux`, `windows`, `darwin`, ... | It equals `GOOS`. `android` also satisfies `linux`, `ios` satisfies `darwin`, `illumos` satisfies `solaris` |
| `amd64`, `arm64`, `wasm`, ... | It equals `GOARCH` |
| `unix` | `GOOS` is a Unix-like system (Linux, the BSDs, macOS, ...). Only usable in `//go:build`, not in file names |
| `cgo` | cgo is enabled (`CGO_ENABLED=1`) |
| `gc`, `gccgo` | The compiler in use |
| `go1.1` ... `go1.27` | One per Go release up to the toolchain's version |
| anything else | You passed it with `-tags name1,name2` |

`unix && !darwin` therefore means Linux, the BSDs, Solaris and other Unix-likes except
macOS, which has its own file.

The rule that makes this work is that **each identifier must be declared exactly once in
the files that are in the build**. Three files define `openCommand`, but any one build sees
exactly one. That is also how you find gaps: build for a platform none of the files covers.

```bash
GOOS=plan9 go build .
```

```text
# example.com/opener
.\main.go:9:28: undefined: openCommand
```

Plan 9 is not Windows, not Darwin and not Unix, so no file defines `openCommand`. Either
add `open_plan9.go`, or add a fallback file whose constraint is the negation of all the
others, such as `//go:build !windows && !darwin && !unix`.

## Real-world uses

| Constraint | Used for |
|---|---|
| `//go:build linux` | Code that calls Linux-only system interfaces |
| `//go:build integration` | Tests that need external services, run with `go test -tags integration ./...` |
| `//go:build ignore` | A helper program (often a code generator) that lives in a package directory but is never part of it; run it with `go run gen.go` |
| `//go:build go1.27` | A file that uses a new standard library API, paired with a `!go1.27` fallback. A lower version tag, such as `go1.21`, also downgrades the language version that file is compiled with |
| `//go:build !race` | Skip a timing-sensitive test under the race detector |

> [!WARNING]
> A `//go:build` line placed after the `package` clause is an ordinary comment. Both
> `debug` files then build together and the compiler says
> `debug redeclared in this block`, with `other declaration of debug` pointing at the
> second file. If you see a "redeclared" error between files whose names or tags look
> mutually exclusive, check that the constraint is the first thing in the file and is
> followed by a blank line. Older code may also have `// +build` lines; those are the
> pre-Go 1.17 syntax, and `go fix` removes them (the `plusbuild` fixer from
> [[vet-fmt-fix]]).

> [!NOTE]
> `go help buildconstraint` is the full reference, including architecture feature tags
> such as `amd64.v3`. Editors only analyse files for your own `GOOS`; to check another
> platform's files, run `GOOS=linux go vet ./...`.

linkcheck needs exactly this when its `--open` flag launches a browser on three operating
systems in [[step-10-ship]].
