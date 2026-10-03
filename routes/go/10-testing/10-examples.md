---
title: Example functions
done_when: "`go test` runs your Example functions and fails when their `// Output:` comment is wrong, and `go doc -ex yourpkg Func` lists the examples for that function."
---
An **example function** is documentation that the test runner checks. It is a function named `ExampleXxx` in a `_test.go` file that prints something and ends with a comment saying what it must print. `go test` runs it and compares. The same function is shown as runnable sample code in `go doc` and on pkg.go.dev. So the documentation cannot drift from the code: when the behaviour changes, the example fails.

## The first example

This module has the `urlnorm` package from the earlier stops of this part. Two functions are new here, `Dedupe` (normalise a list and keep each URL once) and `CountHosts` (count URLs per host):

```go title="urlnorm/urlnorm.go (addition)"
// Dedupe returns urls with each distinct normalised URL kept once, in the
// order first seen. URLs that cannot be normalised are dropped.
func Dedupe(urls []string) []string {
	seen := make(map[string]bool)
	var out []string
	for _, raw := range urls {
		n, err := Normalize(raw)
		if err != nil || seen[n] {
			continue
		}
		seen[n] = true
		out = append(out, n)
	}
	return out
}
```

```go title="urlnorm/host.go (addition)"
// CountHosts returns how many of urls each host serves.
func CountHosts(urls []string) map[string]int {
	counts := make(map[string]int)
	for _, raw := range urls {
		if h := Host(raw); h != "" {
			counts[h]++
		}
	}
	return counts
}
```

```go title="urlnorm/example_test.go"
package urlnorm_test

import (
	"errors"
	"fmt"

	"example.com/examples/urlnorm"
)

func ExampleNormalize() {
	got, err := urlnorm.Normalize("HTTPS://GO.dev:443/doc/#install")
	if err != nil {
		fmt.Println("error:", err)
		return
	}
	fmt.Println(got)
	// Output: https://go.dev/doc/
}

// Rejected schemes are reported with ErrScheme, which errors.Is matches.
func ExampleNormalize_scheme() {
	_, err := urlnorm.Normalize("mailto:gopher@go.dev")
	fmt.Println(errors.Is(err, urlnorm.ErrScheme))
	fmt.Println(err)
	// Output:
	// true
	// "mailto:gopher@go.dev": unsupported scheme
}

func ExampleHost() {
	fmt.Println(urlnorm.Host("http://localhost:8080/health"))
	// Output: localhost:8080
}

func ExampleDedupe() {
	urls := []string{
		"https://go.dev/doc/",
		"HTTPS://GO.dev:443/doc/#install",
		"mailto:gopher@go.dev",
		"https://go.dev/blog/",
	}
	for _, u := range urlnorm.Dedupe(urls) {
		fmt.Println(u)
	}
	// Output:
	// https://go.dev/doc/
	// https://go.dev/blog/
}

// CountHosts returns a map, and a map has no order. "Unordered output"
// passes if the lines match in any order.
func ExampleCountHosts() {
	counts := urlnorm.CountHosts([]string{
		"https://go.dev/doc/",
		"https://go.dev/blog/",
		"https://pkg.go.dev/",
	})
	for host, n := range counts {
		fmt.Println(host, n)
	}
	// Unordered output:
	// go.dev 2
	// pkg.go.dev 1
}

// An example with no "Output:" comment is compiled but never run. Use that
// for code that needs the network or has no stable output.
func ExampleNormalize_noOutput() {
	got, _ := urlnorm.Normalize("https://go.dev/")
	fmt.Println(got, "may print anything, nobody checks")
}
```

```bash
go test -v ./urlnorm
```

```text
--- PASS: ExampleNormalize (0.00s)
--- PASS: ExampleNormalize_scheme (0.00s)
--- PASS: ExampleHost (0.00s)
--- PASS: ExampleDedupe (0.00s)
--- PASS: ExampleCountHosts (0.00s)
PASS
ok  	example.com/examples/urlnorm	0.407s
```

(`=== RUN` lines are left out.) `ExampleNormalize_noOutput` is missing from the list: it has no `Output:` comment, so it is compiled but not run.

## How it works

**The name says what it documents.** `go vet` (and so `go test`) checks that the name refers to something that exists:

| Name | Documents |
|---|---|
| `Example` | The package as a whole |
| `ExampleNormalize` | The function `Normalize` |
| `ExampleSet` | The type `Set` |
| `ExampleSet_Add` | The method `Add` of `Set` |
| `ExampleNormalize_scheme` | Another example for `Normalize`; the suffix after the underscore starts with a **lowercase** letter |

A name that points at nothing is an error, not a silent no-op: `go test` runs `go vet` first, and `ExampleSet_Remove` for a type without a `Remove` method stops the build with `refers to unknown field or method: Set.Remove` (and `ExampleNoSuchFunc` with `refers to unknown identifier: NoSuchFunc`).

A suffix lets one function have several examples: `ExampleNormalize` (the main use) and `ExampleNormalize_scheme` (the error case). An uppercase suffix would read as a method name, and `go vet` would then report a method that does not exist.

**The `// Output:` comment is the assertion.** When an example ends with a comment starting `Output:`, `go test` runs the function, captures what it writes to standard output, trims leading and trailing whitespace from both sides, and compares them. Output can be on the same line (`// Output: localhost:8080`) or on the lines below it, as in `ExampleNormalize_scheme`. The comment must be the **last** comment in the function.

**A mismatch fails with both texts.** If the expected output of `ExampleNormalize` is changed to `https://go.dev/doc` (no trailing slash):

```text
--- FAIL: ExampleNormalize (0.00s)
got:
https://go.dev/doc/
want:
https://go.dev/doc
FAIL
FAIL	example.com/examples/urlnorm	0.433s
FAIL
```

**`Unordered output:` for maps and goroutines.** `CountHosts` returns a map, and ranging over a map visits keys in random order. A plain `Output:` would pass on some runs and fail on others. With `// Unordered output:`, the lines must match, but in any order:

```text
--- FAIL: ExampleCountHosts (0.00s)
got:
go.dev 2
pkg.go.dev 1

want (unordered):
go.dev 3
pkg.go.dev 1

FAIL
FAIL	example.com/examples/urlnorm	0.445s
FAIL
```

This output is from a wrong expected count (`go.dev 3`); with the right one the example passes. If you can, sort inside the example instead and keep the stricter `Output:`.

**No `Output:` comment: compiled, not run.** `ExampleNormalize_noOutput` is type-checked, so it cannot rot into code that does not build, but it never runs. Use that for an example that needs the network or prints something unstable, such as a time.

**Why `package urlnorm_test`.** Examples are written as an importer would write them: `urlnorm.Normalize(...)`, with the package name and with only exported identifiers. That is also what the reader of the documentation will copy.

## Examples in go doc

`go doc` shows the doc comment of a function. Since Go 1.27, `go doc -ex` also lists the executable examples of a package or symbol:

```bash
go doc -ex ./urlnorm Normalize
```

```text
package urlnorm // import "example.com/examples/urlnorm"

func Normalize(raw string) (string, error)
    Normalize lowercases the scheme and host, drops the default port and the
    fragment, and turns an empty path into "/".

    func ExampleNormalize()
    func ExampleNormalize_noOutput()
        An example with no "Output:" comment is compiled but never run. Use that
        for code that needs the network or has no stable output.
    func ExampleNormalize_scheme()
        Rejected schemes are reported with ErrScheme, which errors.Is matches.
```

Each example appears with its own doc comment (the comment above the `func`), which is why `ExampleNormalize_scheme` begins with a sentence saying what it demonstrates. To print the code of one, give its name:

```bash
go doc ./urlnorm ExampleNormalize_scheme
```

```text
package main

import (
	"errors"
	"fmt"

	"example.com/examples/urlnorm"
)

func main() {
	_, err := urlnorm.Normalize("mailto:gopher@go.dev")
	fmt.Println(errors.Is(err, urlnorm.ErrScheme))
	fmt.Println(err)
}

Output: 
true
"mailto:gopher@go.dev": unsupported scheme
```

`go doc` rewrote the example into a complete `main` program with its imports and showed the expected output below it. pkg.go.dev does the same, with a Run button for examples that have output, so a reader can try your package without leaving the page.

## What makes a good example

- **Show the normal use first,** as `ExampleNormalize` does, and the interesting edge cases as suffixed examples.
- **Print the result,** so that `// Output:` checks something. An example that only calls a function and prints nothing is a compile test with no assertion.
- **Keep it short and complete.** It is read as documentation: no helper functions, no setup that hides what is being shown.
- **Explain with the doc comment,** not with comments inside the body. The text above `func ExampleX()` is shown with it.

Examples do not replace tests. A table test covers many inputs and failures; an example shows one path in the way a reader should use it. A good package has both.

> [!WARNING]
> Two mistakes. (1) **A misspelled `Output:` comment.** `//Output:` and `// output:` work, since the match ignores case and spacing, but `// Outputs: ...` and `// Output` with no colon are ordinary comments: the example silently becomes compile-only and you believe it is tested. Symptom: it does not appear in `go test -v` output. Fix: run `go test -v` and check that the example is listed as passed. (2) **Printing something that varies**, such as a map, a timestamp or a pointer. Symptom: the example passes on your machine and fails elsewhere, or about one run in two. Fix: sort, format a fixed value, or use `Unordered output:`.

> [!NOTE]
> Examples that print to standard output only: the runner captures `os.Stdout`. An example that writes to `os.Stderr` or logs through `log` is not compared.

linkcheck carries an example like these on `Normalize`, so that `go doc` shows how to call it; the end-to-end version of that discipline is in [[step-6-tests]].
