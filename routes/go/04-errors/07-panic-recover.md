---
title: panic and recover
done_when: "You return errors for failures and panic only for bugs, you can convert a panic to an error at a boundary with a deferred recover and a named result, and you can read an unrecovered panic's output."
---
A **panic** stops the normal execution of the current goroutine. The runtime panics on
bugs it detects (an index out of range, a nil map write, a nil pointer dereference, a
failed single-value type assertion), and your code can call the built-in `panic(v)` with
any value. While panicking, the goroutine runs the deferred calls of each function on its
stack, innermost first, and if nothing stops it, the program prints the value and a stack
trace and exits with status 2.

**`recover()`**, called directly by a deferred function, stops the panic and returns the
value passed to `panic`. The function whose deferred call recovered then returns normally
to its caller.

Panics are not Go's exceptions. Errors that can happen in a correct program (bad input, a
missing file, a timeout) are returned as `error` values ([[errors-as-values]]). A panic
means "this program has a bug" or "this state should be impossible". `recover` exists so a
server or library can keep one bug in one request from killing everything.

```go title="main.go"
package main

import (
	"errors"
	"fmt"
	"runtime"
)

// safely runs f and turns a panic into an error. The named result lets the
// deferred function replace what the caller receives.
func safely(name string, f func()) (err error) {
	defer func() {
		r := recover()
		if r == nil {
			return // no panic
		}
		if re, ok := r.(runtime.Error); ok {
			err = fmt.Errorf("%s: runtime error recovered: %w", name, re)
			return
		}
		err = fmt.Errorf("%s: panic recovered: %v", name, r)
	}()
	f()
	return nil
}

func main() {
	var m map[string]int
	var links []string

	errs := []error{
		safely("ok", func() {}),
		safely("index", func() { fmt.Println(links[3]) }),
		safely("nil map", func() { m["x"]++ }),
		safely("explicit", func() { panic("unreachable state: depth < 0") }),
		safely("panic(nil)", func() { panic(nil) }),
	}
	for _, err := range errs {
		fmt.Println(err)
	}

	_, isRuntime := errors.AsType[runtime.Error](errs[1])
	fmt.Println("index panic is runtime.Error:", isRuntime)
}
```

```bash
go run .
```

```text
<nil>
index: runtime error recovered: runtime error: index out of range [3] with length 0
nil map: runtime error recovered: assignment to entry in nil map
explicit: panic recovered: unreachable state: depth < 0
panic(nil): runtime error recovered: runtime error: panic called with nil argument
index panic is runtime.Error: true
```

## How it works

- `f()` panics inside `safely`. Execution of `f` and of `safely` stops, and the deferred
  closure runs. Its `recover()` returns the panic value and ends the panic. The closure
  sets the named result `err` (the technique from [[defer]]), and `safely` returns that
  error to `main` as if it had returned normally.
- `recover()` returns `any`. Panics raised by the runtime carry a value implementing
  `runtime.Error` (an `error` with a marker method `RuntimeError()`), which lets you tell a
  runtime-detected bug from a value your own code passed to `panic`. Wrapping it with `%w`
  keeps it findable with `errors.AsType`.
- `panic(nil)`: since Go 1.21, `recover` returns a `*runtime.PanicNilError` instead of
  `nil`, so a recovered panic is never mistaken for "no panic". The spec guarantees that
  `recover` returns non-nil whenever it stops a panic.
- When there is no panic, `recover()` returns `nil` and does nothing; that is the
  `safely("ok", ...)` case.

## The rules of recover

`recover` only works in one place: **called directly by a deferred function, while the
goroutine is panicking**. Everywhere else it returns `nil`.

```go title="main.go"
package main

import (
	"fmt"
	"os"
)

// logRecover calls recover, but it is not the deferred function itself.
func logRecover() {
	if r := recover(); r != nil {
		fmt.Println("recovered:", r)
	}
}

func indirect() {
	defer func() {
		logRecover() // recover is called by a function the deferred func calls: returns nil
	}()
	panic("first")
}

func main() {
	fmt.Println("recover outside a panic:", recover())
	defer fmt.Println("main's deferred call runs during the panic")
	if len(os.Args) > 1 {
		defer func() {
			r := recover()
			fmt.Println("cleaning up after:", r)
			panic(r) // re-panic: we only wanted to observe it
		}()
	}
	indirect()
	fmt.Println("not reached")
}
```

```bash
go build -o panicdemo . && ./panicdemo; echo "exit status $?"
```

```text
recover outside a panic: <nil>
main's deferred call runs during the panic
panic: first

goroutine 1 [running]:
main.indirect()
	/home/you/panicdemo/main.go:19 +0x3e
main.main()
	/home/you/panicdemo/main.go:32 +0xd1
exit status 2
```

```bash
./panicdemo re; echo "exit status $?"
```

```text
recover outside a panic: <nil>
cleaning up after: first
main's deferred call runs during the panic
panic: first [recovered, repanicked]

goroutine 1 [running]:
main.main.func1()
	/home/you/panicdemo/main.go:29 +0x6d
panic({0x7ff7a35e2e60?, 0x7ff7a3521248?})
	/usr/local/go/src/runtime/panic.go:859 +0x125
main.indirect()
	/home/you/panicdemo/main.go:19 +0x3e
main.main()
	/home/you/panicdemo/main.go:32 +0xd1
exit status 2
```

Paths and addresses in the traces will differ on your machine.

Reading the two runs:

- `recover()` in `main` before any panic returns `nil`.
- In `indirect`, the deferred closure calls `logRecover`, which calls `recover`. Because
  `recover` was not called *directly* by the deferred function, it returns `nil`, nothing
  prints, and the panic continues. Helpers that "handle panics for you" must therefore be
  deferred themselves: `defer logRecover()` would have worked.
- The panic unwinds into `main` and runs `main`'s deferred calls. The program then prints
  `panic: first`, the goroutine's stack (read it top-down: the top frame is where the
  panic happened), and exits with status 2.
- The second run recovers in `main` and re-panics with the same value. Since Go 1.25 the
  report says `[recovered, repanicked]` instead of printing the value twice. Re-panicking
  is right when you only wanted to log or clean up, not to handle the failure.

## When to panic

| Situation | Use |
|---|---|
| Input from users, files, the network | Return an `error` |
| A broken invariant: "this can't happen" in your own code | `panic` with a message that says which invariant |
| Invalid constant setup at program start, such as a hard-coded regexp | A `Must` function: `regexp.MustCompile`, `template.Must` |
| A request handler or worker in a long-running server | `recover` at the top of each request or job, log the stack, return an error |
| A library API | Never let a panic cross it; recover and return an `error`, or document the panic |

The `Must` convention makes the difference concrete:

```go title="main.go"
package main

import (
	"fmt"
	"regexp"
)

// Compiled once at program start. A bad pattern is a bug in this file,
// so MustCompile panics instead of returning an error.
var hrefPattern = regexp.MustCompile(`href="([^"]+)"`)

func main() {
	fmt.Println(hrefPattern.FindStringSubmatch(`<a href="/docs">docs</a>`)[1])

	// User input is different: it can be wrong, so use Compile and handle the error.
	userPattern := `/blog/(`
	if _, err := regexp.Compile(userPattern); err != nil {
		fmt.Println("bad --exclude pattern:", err)
	}

	regexp.MustCompile(userPattern) // a panic here would crash the program
}
```

```text
/docs
bad --exclude pattern: error parsing regexp: missing closing ): `/blog/(`
panic: regexp: Compile(`/blog/(`): error parsing regexp: missing closing ): `/blog/(`
```

A bad hard-coded pattern panics the first time the program starts, so it can never ship.
A bad pattern from a flag must be reported as an error, because the user, not the
programmer, made the mistake.

> [!WARNING]
> Using `panic` and `recover` as exceptions for ordinary failures (`panic(err)` deep
> inside, `recover` at the top). Symptom: control flow nobody can follow, deferred cleanup
> that assumed normal returns, and panics that escape through a path you did not wrap.
> Fix: return errors. Keep `recover` at a few explicit boundaries, and always log the
> stack (`runtime/debug.Stack()`) when you recover, or the bug becomes invisible.

> [!WARNING]
> A panic can only be recovered by a deferred call **in the same goroutine**. A panic in a
> goroutine started with `go` that does not recover crashes the whole program, no matter
> what `main` defers ([[goroutines]]). Every goroutine that may panic needs its own
> deferred recover if the program must survive it.

> [!NOTE]
> Some failures are not panics and cannot be recovered: `fatal error: stack overflow`
> ([[stringer-fmt]] showed one), `fatal error: concurrent map writes`, and running out of
> memory. They always terminate the program. `os.Exit` and `log.Fatal` exit without
> running deferred calls at all.

linkcheck's workers in [[step-3-concurrent]] do not recover: a panic in one is a bug, and
it stops the whole crawl instead of hiding in the report.
