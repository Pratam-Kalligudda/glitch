---
title: gofmt, go vet and go fix
done_when: "`gofmt -l .` prints nothing, `go vet ./...` exits 0, and `go fix -diff ./...` shows no changes in your module."
---
Go ships three source tools that every Go project runs, so every Go codebase looks and
reads the same way:

- **gofmt** rewrites layout. There is one Go style and no options to argue about.
- **go vet** reports code that compiles but is almost certainly wrong.
- **go fix** rewrites working code to use newer language features and library APIs. Since
  Go 1.26 it is the home of the **modernizers**.

They differ in what they are allowed to change, and that is the key to using them: gofmt
changes only whitespace and layout, go fix changes code but never behaviour, go vet changes
nothing and only reports.

## gofmt

```go title="messy.go"
package main
import "fmt"
type point struct{
  X int
  Name string
}
func main(){
    p:=point{X:1,Name:"a"}
  pts := []point{point{X: 2, Name: "b"}}
  for i:=0;i<len(pts);i++ {fmt.Println(pts[i],p)}
}
```

`gofmt -l` lists files whose formatting differs; `-d` shows the diff; `-w` writes it back.

```bash
gofmt -l .
gofmt -s -d messy.go
```

```text
messy.go
diff messy.go.orig messy.go
--- messy.go.orig
+++ messy.go
@@ -1,11 +1,16 @@
 package main
+
 import "fmt"
-type point struct{
-  X int
-  Name string
-}
-func main(){
-    p:=point{X:1,Name:"a"}
-  pts := []point{point{X: 2, Name: "b"}}
-  for i:=0;i<len(pts);i++ {fmt.Println(pts[i],p)}
+
+type point struct {
+	X    int
+	Name string
+}
+
+func main() {
+	p := point{X: 1, Name: "a"}
+	pts := []point{{X: 2, Name: "b"}}
+	for i := 0; i < len(pts); i++ {
+		fmt.Println(pts[i], p)
+	}
 }
```

What gofmt decides: tabs for indentation, spaces for alignment (the field types line up in
a column), spacing around operators based on precedence, one statement per line, a blank
line between top-level declarations, imports sorted within each group. `-s` adds
simplifications that do not change meaning, such as dropping the repeated `point` type
inside `[]point{...}`.

`go fmt ./...` runs `gofmt -l -w` over packages. In practice your editor runs gofmt (via
gopls) on save, and CI fails if `gofmt -l .` prints anything.

## go vet

```go title="main.go"
package main

import (
	"fmt"
	"sync"
)

type Counter struct {
	mu sync.Mutex
	n  int
}

func (c Counter) Inc() {
	c.mu.Lock()
	c.n++
	c.mu.Unlock()
}

func main() {
	var c Counter
	c.Inc()
	c.Inc()
	name := "gopher"
	fmt.Printf("hello %d\n", name)
	fmt.Println("count:", c.n)
}
```

It compiles and runs, wrongly:

```bash
go run .
```

```text
hello %!d(string=gopher)
count: 0
```

```bash
go vet .
```

```text
main.go:13:9: Inc passes lock by value: example.com/vetdemo.Counter contains sync.Mutex
main.go:24:20: fmt.Printf format %d has arg name of wrong type string
```

Both reports are real bugs. `Inc` has a value receiver, so it increments a copy of the
counter and locks a copy of the mutex; the caller's `n` stays 0 (the rule is in
[[method-sets]]). `%d` with a string prints a `%!d(...)` marker instead of failing. Change
the receiver to `*Counter` and the verb to `%s`, and both vet and the output are clean:

```text
hello gopher
count: 2
```

### How vet decides

vet is a set of **analyzers**, each a static check for one bug pattern. It reports only
patterns with a very low false-positive rate, so a vet warning is worth fixing, not
silencing. `go tool vet help` lists them; the ones you meet most:

| Analyzer | Catches |
|---|---|
| `printf` | Format verbs that do not match their arguments, wrong argument counts |
| `copylocks` | Copying a value that contains a `sync.Mutex` or similar |
| `loopclosure` | Loop variables captured by goroutines (mostly gone since Go 1.22; see [[loop-variables]]) |
| `lostcancel` | A `context.WithCancel` cancel function that is never called |
| `structtag` | Malformed struct tags such as `json:name` without quotes |
| `stringintconv` | `string(i)` where `i` is an integer, which makes a rune, not digits |
| `unusedresult` | Ignoring the result of calls like `fmt.Sprintf` |
| `httpresponse` | Using an `http.Response` before checking the error |
| `stdversion` | Using a standard library symbol newer than the module's `go` line |

`go test` runs a high-confidence subset of vet (atomic, bools, buildtag, directive,
errorsas, ifaceassert, nilfunc, printf, stdversion, stringintconv and tests) before every
test run and refuses to run the tests if one fires. Run the full `go vet ./...` in CI as
well.

## go fix and the modernizers

Go keeps adding features that make old idioms obsolete: `any` for `interface{}` (Go 1.18),
`range 10` (Go 1.22), `strings.CutPrefix` (Go 1.20), `min` and `max` (Go 1.21). go fix finds
the old form and rewrites it.

```go title="old.go"
package main

import (
	"fmt"
	"sort"
	"strings"
)

func describe(v interface{}) string {
	return fmt.Sprint(v)
}

func main() {
	words := []string{"pear", "apple", "fig"}
	sort.Strings(words)
	for i := 0; i < len(words); i++ {
		fmt.Println(i, describe(words[i]))
	}
	longest := 0
	for _, w := range words {
		if len(w) > longest {
			longest = len(w)
		}
	}
	fmt.Println("longest:", longest)
	if strings.HasPrefix(words[0], "ap") {
		fmt.Println(strings.TrimPrefix(words[0], "ap"))
	}
}
```

`go fix -diff` shows the changes without writing them (file paths shortened):

```bash
go fix -diff .
```

```text
--- old.go (old)
+++ old.go (new)
@@ -6,14 +6,14 @@
 	"strings"
 )
 
-func describe(v interface{}) string {
+func describe(v any) string {
 	return fmt.Sprint(v)
 }
 
 func main() {
 	words := []string{"pear", "apple", "fig"}
 	sort.Strings(words)
-	for i := 0; i < len(words); i++ {
+	for i := range words {
 		fmt.Println(i, describe(words[i]))
 	}
 	longest := 0
@@ -23,7 +17,7 @@
 		}
 	}
 	fmt.Println("longest:", longest)
-	if strings.HasPrefix(words[0], "ap") {
-		fmt.Println(strings.TrimPrefix(words[0], "ap"))
+	if after, ok := strings.CutPrefix(words[0], "ap"); ok {
+		fmt.Println(after)
 	}
 }
```

`go fix .` applies them; the program prints the same before and after:

```text
0 apple
1 fig
2 pear
longest: 5
ple
```

### How go fix decides

Each fixer is an analyzer that comes with a suggested edit, and each edit must not change
behaviour. That is why the `longest` loop was left alone (only some loop shapes provably
equal `max`) and `sort.Strings` was not touched. Fixers also respect the language version:
a fixer only uses features your `go` line allows. The same `for i := 0; i < 3; i++` loop
gets no change in a module that says `go 1.21` and becomes `for i := range 3` in one that
says `go 1.27`.

`go tool fix help` lists the fixers. A selection:

| Fixer | Rewrites |
|---|---|
| `any` | `interface{}` to `any` |
| `rangeint` | Three-clause loops to `for i := range n` |
| `minmax` | if/else that picks a bound to `min`/`max` |
| `stringscutprefix` | `HasPrefix` + `TrimPrefix` to `CutPrefix` |
| `stringsseq` | Ranging over `strings.Split` to `strings.SplitSeq` |
| `slicescontains` | Search loops to `slices.Contains` |
| `forvar` | Removes `x := x` copies made obsolete by Go 1.22 loop variables |
| `waitgroupgo` | `wg.Add(1); go func(){ defer wg.Done() ... }()` to `wg.Go` |
| `newexpr` | Helper functions that return a pointer to a value, to `new(expr)` (Go 1.26) |
| `inline` | Calls to functions marked `//go:fix inline`, replaced by their body |

Select fixers with `-name` flags, for example `go fix -any -rangeint ./...`.

> [!WARNING]
> Running `go fix ./...` and committing the result together with a feature change makes the
> feature impossible to review: hundreds of mechanical edits bury the real ones. Run it in a
> commit of its own, with `go test ./...` before and after. In CI, use `go fix -diff ./...`
> and `gofmt -l .` as checks: both print what is wrong, and `go fix -diff` exits non-zero
> when it would change something.

> [!NOTE]
> Before Go 1.26, the modernizers lived in gopls and a separate `modernize` command; `go fix`
> held only long-obsolete rewrites. Go 1.27 renamed the `waitgroup` fixer to `waitgroupgo`
> and added `atomictypes`, `embedlit`, `slicesbackward` and `unsafefuncs`. Release notes:
> <https://go.dev/doc/go1.26> and <https://go.dev/doc/go1.27>.

linkcheck runs `gofmt -l`, `go vet ./...` and `go fix -diff ./...` alongside its tests before
it ships, in [[step-10-ship]].
