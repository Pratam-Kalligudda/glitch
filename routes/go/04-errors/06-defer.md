---
title: defer in depth
done_when: "You can predict the output of a function with several defers (order, argument values, named results), you close writable files without losing the Close error, and you never defer inside a long loop."
---
A `defer` statement schedules a function call to run when the surrounding function
returns, however it returns: a `return` statement, falling off the end, or a panic. It
keeps cleanup next to the code that needs it (`f, err := os.Open(...)` then
`defer f.Close()`), so no early `return` can skip it. Three rules decide what a deferred
call actually does, and each one explains a common bug: the **order** deferred calls run
in, **when their arguments are evaluated**, and their access to **named results**.

```go title="main.go"
package main

import "fmt"

type counter struct{ name string }

func (c counter) report() { fmt.Println("  method value, receiver copied at defer:", c.name) }

func order() {
	for i := 0; i < 3; i++ {
		defer fmt.Println("  deferred", i)
	}
	fmt.Println("  body done")
}

func evaluation() {
	x := 1
	defer fmt.Println("  argument evaluated at defer:", x)
	defer func() { fmt.Println("  closure reads x when it runs:", x) }()

	c := counter{name: "before"}
	defer c.report()
	c.name = "after"

	x = 2
}

// adjusted returns n*2, then the deferred closure multiplies the named result by 10.
func adjusted(n int) (result int) {
	defer func() {
		fmt.Printf("  return set result=%d; the deferred func sees it\n", result)
		result *= 10
	}()
	return n * 2
}

func main() {
	fmt.Println("order:")
	order()
	fmt.Println("evaluation:")
	evaluation()
	fmt.Println("named result:")
	fmt.Println("  adjusted(3) =", adjusted(3))
}
```

```bash
go run .
```

```text
order:
  body done
  deferred 2
  deferred 1
  deferred 0
evaluation:
  method value, receiver copied at defer: before
  closure reads x when it runs: 2
  argument evaluated at defer: 1
named result:
  return set result=6; the deferred func sees it
  adjusted(3) = 60
```

## How it works

The Go specification states the rules precisely.

1. **Last in, first out.** Each time a `defer` statement *executes*, its call is pushed
   onto the function's list of deferred calls. When the function returns, they run in
   reverse order. `order` deferred three calls in a loop, so they ran 2, 1, 0. Reverse
   order is what you want for cleanup: resources acquired later, which may depend on
   earlier ones, are released first.
2. **The function value and arguments are evaluated when `defer` executes**, and saved;
   only the call is postponed. `fmt.Println("...", x)` captured `x == 1`, even though `x`
   was 2 when it ran. `c.report()` evaluated the method value, including a copy of the
   value receiver `c`, so it printed `before`. A function literal with no arguments is
   different: its *body* runs later and reads variables as they are then, so the closure
   saw `x == 2`.
3. **Deferred calls run after `return` sets the results, before the caller gets them.**
   `return n * 2` assigned 6 to the named result `result`; the deferred closure read 6 and
   changed it to 60, and the caller received 60. This only works with named results; with
   an unnamed result, a deferred function has no name through which to reach it. Any
   values a deferred function itself returns are discarded.

Since Go 1.14, the compiler implements most defers inline ("open-coded"), with almost no
overhead compared to a direct call, so performance is not a reason to avoid `defer`.

## The real-world form: Close errors and loops

For a file you only read, `defer f.Close()` is fine; a failed close of a reader loses
nothing. For a file you *write*, `Close` can be the call that reports the failure, and
`defer f.Close()` silently drops its error. Rule 3 gives the fix: a named `err` result and
a deferred closure that joins the close error into it ([[join]]).

The example uses a stand-in type whose `Close` can fail on demand, so the failure is
reproducible:

```go title="main.go"
package main

import (
	"errors"
	"fmt"
	"io"
	"strings"
)

// flakyFile is a stand-in for an *os.File whose Close fails, as a full disk or a
// network file system can make it do.
type flakyFile struct {
	name      string
	failClose bool
	sb        strings.Builder
}

func (f *flakyFile) Write(p []byte) (int, error) { return f.sb.Write(p) }

func (f *flakyFile) Close() error {
	fmt.Println("  close", f.name)
	if f.failClose {
		return errors.New("close " + f.name + ": no space left on device")
	}
	return nil
}

var open = 0

func create(name string, failClose bool) *flakyFile {
	open++
	return &flakyFile{name: name, failClose: failClose}
}

// writeReport closes the file on every path and does not lose a Close error.
func writeReport(name string, lines []string, failClose bool) (err error) {
	f := create(name, failClose)
	defer func() {
		open--
		err = errors.Join(err, f.Close())
	}()
	for _, l := range lines {
		if _, err := io.WriteString(f, l+"\n"); err != nil {
			return err
		}
	}
	return nil
}

// leaky defers inside a loop: nothing closes until the function returns.
func leaky(names []string) {
	for _, n := range names {
		f := create(n, false)
		defer func() { open--; f.Close() }()
		fmt.Println("  processing", n, "- open files:", open)
	}
}

// fixed moves the loop body into its own function, so each defer runs per iteration.
func fixed(names []string) {
	for _, n := range names {
		func() {
			f := create(n, false)
			defer func() { open--; f.Close() }()
			fmt.Println("  processing", n, "- open files:", open)
		}()
	}
}

func main() {
	fmt.Println("writeReport, Close succeeds:")
	fmt.Println("  err:", writeReport("ok.txt", []string{"200 /"}, false))
	fmt.Println("writeReport, Close fails:")
	fmt.Println("  err:", writeReport("full.txt", []string{"200 /"}, true))

	names := []string{"a.html", "b.html", "c.html"}
	fmt.Println("defer in a loop:")
	leaky(names)
	fmt.Println("defer in a function per iteration:")
	fixed(names)
}
```

```text
writeReport, Close succeeds:
  close ok.txt
  err: <nil>
writeReport, Close fails:
  close full.txt
  err: close full.txt: no space left on device
defer in a loop:
  processing a.html - open files: 1
  processing b.html - open files: 2
  processing c.html - open files: 3
  close c.html
  close b.html
  close a.html
defer in a function per iteration:
  processing a.html - open files: 1
  close a.html
  processing b.html - open files: 1
  close b.html
  processing c.html - open files: 1
  close c.html
```

- In `writeReport`, every `return` sets `err` first; then the deferred closure runs and
  replaces `err` with `errors.Join(err, f.Close())`. If both succeed it stays nil; if only
  `Close` fails the caller sees that; if both fail the caller sees both. Inside the loop,
  `if _, err := ...` declares a new `err` that shadows the result; `return err` still
  assigns it to the named result, so this is safe.
- `leaky` defers in a loop. Deferred calls belong to the *function*, not the loop
  iteration, so nothing closes until `leaky` returns: open files grow with the input.
  With thousands of files that hits the operating system's limit and fails with "too many
  open files". `fixed` wraps each iteration in a function literal, so each iteration's
  `defer` runs at the end of that iteration.

> [!WARNING]
> `defer f.Close()` on a file you wrote. Symptom: the program reports success, but the
> file is incomplete because the final write failed on close. Fix: use a named `err`
> result and `defer func() { err = errors.Join(err, f.Close()) }()`, or call `Close`
> explicitly and check it.

> [!WARNING]
> `defer` inside a loop over many items. Symptom: memory or file descriptors grow until
> the function returns, then "too many open files". Fix: move the body into a function
> (named or literal) so the defer runs once per item.

## Edge cases

| Situation | What happens |
|---|---|
| `os.Exit` | The program ends at once; deferred calls do **not** run. `log.Fatal` calls `os.Exit` too. |
| A panic | Deferred calls run while the stack unwinds; see [[panic-recover]]. |
| `runtime.Goexit` | Deferred calls run; the goroutine ends. |
| Deferred function value is nil | `defer f()` with a nil `f` is accepted; the panic happens when the call would run, after the function's body. |
| `defer mu.Unlock()` | The idiomatic way to release a lock on every path ([[mutexes]]). |
| Arguments with side effects | Evaluated once, at the `defer` statement: `defer log(time.Since(start))` measures zero time; use `defer func() { log(time.Since(start)) }()`. |

`main` returning is a normal return, so its defers run; that is why programs that need
an exit code usually do the work in a `run() error` function and call `os.Exit` only in
`main`, after `run`'s defers have finished ([[exit-codes]]).

linkcheck saves its crawl state with the named-result cleanup pattern in [[step-8-state]],
and checks the error from closing its report file.
