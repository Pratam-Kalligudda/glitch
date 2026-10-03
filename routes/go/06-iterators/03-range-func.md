---
title: Range over functions
done_when: "You can range over an iter.Seq and an iter.Seq2, say what yield returning false means, and explain what break, return and defer do inside such a loop."
---
(Go 1.23) `for ... range` can loop over a **function**. This lets any type offer its own
loop: a tree in order, lines of a file, rows of a query, the keys of a map in sorted order.
The loop looks the same as a loop over a slice, and `break`, `continue` and `return` work in
it.

The function you range over is an **iterator**. It has the shape `func(yield func(V) bool)`:
the iterator receives a function `yield` and calls it once for every value. `yield` is the
loop body. It returns `true` to ask for the next value and `false` when the loop wants to
stop, for example on `break`.

The `iter` package names the two shapes. `iter.Seq[V]` is `func(yield func(V) bool)`, and
`iter.Seq2[K, V]` is `func(yield func(K, V) bool)`, for loops with two variables.

```go title="main.go"
package main

import (
	"fmt"
	"iter"
)

// Countdown is an iterator: a function that calls yield for each value.
func Countdown(from int) iter.Seq[int] {
	return func(yield func(int) bool) {
		for i := from; i > 0; i-- {
			if !yield(i) {
				fmt.Println("countdown: stopped early")
				return
			}
		}
		fmt.Println("countdown: finished")
	}
}

// Enumerate yields index and value pairs.
func Enumerate[T any](s []T) iter.Seq2[int, T] {
	return func(yield func(int, T) bool) {
		for i, v := range s {
			if !yield(i, v) {
				return
			}
		}
	}
}

func find() int {
	for n := range Countdown(10) {
		if n%4 == 0 {
			return n // returning from inside the loop body works
		}
	}
	return -1
}

func main() {
	for n := range Countdown(3) {
		fmt.Println("n =", n)
	}

	for n := range Countdown(5) {
		if n == 3 {
			break
		}
		fmt.Println("n =", n)
	}

	for i, s := range Enumerate([]string{"a", "b"}) {
		fmt.Println(i, s)
	}

	fmt.Println("found", find())

	// With no variables the body is still called once per value.
	count := 0
	for range Countdown(4) {
		count++
	}
	fmt.Println("count", count)

	// An iterator is a function value: you can call it with your own yield.
	Countdown(2)(func(n int) bool {
		fmt.Println("direct", n)
		return true
	})
	fmt.Printf("%T\n", Countdown(1))
}
```

```bash
go run .
```

```text
n = 3
n = 2
n = 1
countdown: finished
n = 5
n = 4
countdown: stopped early
0 a
1 b
countdown: stopped early
found 8
countdown: finished
count 4
direct 2
direct 1
countdown: finished
iter.Seq[int]
```

## How it works

**The compiler turns the loop body into the `yield` function.** For
`for n := range Countdown(3) { ... }` the compiler calls the iterator with a function whose
parameter is `n` and whose body is your loop body. Each call of `yield(i)` runs one iteration
and returns whether to continue. This is a **push** iterator: the iterator drives, and pushes
values into your loop. ([[pull-iterators]] covers the opposite style.)

**`yield` returning false means "stop now".** `break`, a `return`, a `goto` out of the
loop, or a `continue` or `break` to an outer label all make the compiler's `yield` return
`false`. The iterator must then stop calling `yield`, do its cleanup and return. In the
output, the `break` at `n == 3` printed `stopped early`, and `find` printed it before
`found 8`. After `yield` returns `false`, the loop statement completes and the compiler
carries out the `break` or `return`.

**A plain `continue` is not special.** It ends the current body run and returns `true` to the
iterator, so the next value comes.

**The variables are whatever the iterator yields.** A `Seq` gives zero or one variable, a
`Seq2` gives zero, one or two. A function with the wrong shape is not rangeable:

```go title="main.go"
package main

import "fmt"

func Two(yield func(int, string) bool) {
	yield(1, "a")
}

func main() {
	for a, b, c := range Two {
		fmt.Println(a, b, c)
	}
}
```

```text
./main.go:10:12: range clause permits at most two iteration variables
./main.go:11:21: undefined: c
```

A function that yields three values, or whose `yield` has the wrong signature, is rejected
too: `cannot range over Three (...): func must be func(yield func(...) bool): yield func has
too many parameters`. The iterator itself may be any function with the right shape: a
method value, a closure, or a named function. You do not need the `iter` package types; they
document intent.

## What the iterator must do

The one rule: **stop when `yield` returns `false`**. An iterator that ignores the result and
keeps calling `yield` fails at run time:

```go title="main.go"
package main

import "fmt"

// Bad ignores the result of yield.
func Bad(yield func(int) bool) {
	for i := 0; i < 5; i++ {
		yield(i)
	}
}

func main() {
	for n := range Bad {
		fmt.Println(n)
		if n == 1 {
			break
		}
	}
}
```

```text
0
1
panic: runtime error: range function continued iteration after function for loop body returned false

goroutine 1 [running]:
main.main-range1(...)
	.../main.go:13
main.Bad(...)
	.../main.go:8
main.main()
	.../main.go:13 +0x8a
exit status 2
```

The `break` made the loop body return `false`; `Bad` called `yield` again, and the runtime
panicked instead of running a loop body that has already finished. The trace names the loop
body as `main.main-range1` and shows the iterator `Bad` calling it. Fix: `if !yield(i) { return }`.

The runtime also panics if `yield` is called after the whole loop has finished, for example
when the iterator saved `yield` in a variable and called it later. The message is
`panic: runtime error: range function continued iteration after whole loop exit`. Call
`yield` only while the iterator runs.

## defer, labels and nested loops

`defer` inside an iterator runs when the iterator returns, so cleanup there runs as soon as
the loop ends. `defer` inside the *loop body* belongs to the function containing the
`for`, as for any loop, not to a single iteration:

```go title="main.go"
package main

import (
	"fmt"
	"iter"
)

func Seq(n int) iter.Seq[int] {
	return func(yield func(int) bool) {
		defer fmt.Println("seq: cleanup")
		for i := range n {
			if !yield(i) {
				return
			}
		}
	}
}

func run() {
	defer fmt.Println("run: deferred")
	for i := range Seq(3) {
		defer fmt.Println("body defer", i)
		fmt.Println("body", i)
	}
	fmt.Println("run: loop done")
}

func main() {
	run()
	fmt.Println("---")
outer:
	for i := range Seq(2) {
		for j := range Seq(2) {
			if j == 1 {
				continue outer
			}
			fmt.Println(i, j)
		}
	}
}
```

```text
body 0
body 1
body 2
seq: cleanup
run: loop done
body defer 2
body defer 1
body defer 0
run: deferred
---
0 0
seq: cleanup
1 0
seq: cleanup
seq: cleanup
```

The iterator's `seq: cleanup` ran right after the last iteration, before the line after the
loop. The three `body defer` calls ran when `run` returned, last in first out, as for any
`defer` in a loop ([[defer]]). A `continue outer` stops the inner iterator, which cleans up,
then the outer loop moves on; the last `seq: cleanup` is the outer iterator ending.

A panic in the loop body propagates up through the iterator and out of the `for`, so
a `defer` in the iterator runs for it too.

## Why this exists

Before Go 1.23 there were three ways to expose a sequence: return a slice (allocates it
all), expose a callback `Each(func(T))` (cannot `break` or `return`), or a channel with a
goroutine (heavy, and leaks if the reader stops). Range over functions gives the callback's
cheapness, with normal loop syntax and control flow. The standard library uses it:
`slices.Values`, `maps.Keys`, `strings.SplitSeq`, `bytes.Lines` and others ([[slices-maps-pkgs]]).

> [!WARNING]
> An iterator that ignores `yield`'s result. Symptom: the program works until a caller
> exits the loop early with `break` or `return`, then panics with `range function
> continued iteration after function for loop body returned false`. The tests that only run
> a loop to the end never find it. Fix: check `if !yield(...) { return }` at every call to
> `yield`, including inside nested loops and helper functions, and test every iterator with
> an early `break`.

> [!NOTE]
> The language rules are in the spec under "For statements with range clause"
> (<https://go.dev/ref/spec#For_range>); the package is documented at
> <https://pkg.go.dev/iter>.

Writing your own, with a complete checklist, is next: [[writing-iterators]]. linkcheck's
reporters range over its results this way in [[step-7-reporters]].
