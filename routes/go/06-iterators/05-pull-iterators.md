---
title: Pull iterators
done_when: "You can turn an iter.Seq into next and stop with iter.Pull, say when you need it instead of a range loop, and always call stop."
---
A `range` loop over a function is **push** style: the iterator calls your loop body. Some
algorithms need the opposite, where you ask for the next value when you want it. Merging two
sorted sequences is the classic case: you must look at the front of both, take the smaller,
and advance only that one. A single `for range` cannot advance two iterators independently.

`iter.Pull` converts a push iterator into a **pull** iterator: two functions, `next` and
`stop`.

```go title="main.go"
package main

import (
	"fmt"
	"iter"
	"slices"
)

func Count(n int) iter.Seq[int] {
	return func(yield func(int) bool) {
		defer fmt.Println("count: cleanup")
		for i := 1; i <= n; i++ {
			fmt.Println("count: yielding", i)
			if !yield(i) {
				fmt.Println("count: told to stop")
				return
			}
		}
	}
}

// Merge combines two sorted sequences. It needs to advance each one
// independently, which a single range loop cannot do.
func Merge(a, b iter.Seq[int]) iter.Seq[int] {
	return func(yield func(int) bool) {
		nextA, stopA := iter.Pull(a)
		defer stopA()
		nextB, stopB := iter.Pull(b)
		defer stopB()

		va, okA := nextA()
		vb, okB := nextB()
		for okA || okB {
			if okA && (!okB || va <= vb) {
				if !yield(va) {
					return
				}
				va, okA = nextA()
			} else {
				if !yield(vb) {
					return
				}
				vb, okB = nextB()
			}
		}
	}
}

func main() {
	next, stop := iter.Pull(Count(5))
	v, ok := next()
	fmt.Println("got", v, ok)
	v, ok = next()
	fmt.Println("got", v, ok)
	stop() // ends the iterator: its deferred cleanup runs now
	v, ok = next()
	fmt.Println("after stop", v, ok)

	merged := Merge(slices.Values([]int{1, 4, 6}), slices.Values([]int{2, 3, 7, 8}))
	fmt.Println(slices.Collect(merged))
}
```

```bash
go run .
```

```text
count: yielding 1
got 1 true
count: yielding 2
got 2 true
count: told to stop
count: cleanup
after stop 0 false
[1 2 3 4 6 7 8]
```

## How it works

**`next()` runs the iterator until its next `yield`.** `iter.Pull(seq)` does not run `seq`
yet. The first `next()` starts it; it runs until it calls `yield(v)`, which suspends it and
makes `next` return `(v, true)`. The next call to `next` resumes it from that point. Notice
the output: `count: yielding 2` appears only when the second `next()` was called. The
iterator advances one value per call, not ahead of you.

**When the sequence ends, `next` returns the zero value and `false`.** Calling `next` again
after the end, or after `stop`, keeps returning `(0, false)`; it does not panic.

**`stop()` ends the iteration early.** It makes the suspended `yield` return `false`, so the
iterator runs its `if !yield(...)` branch (`count: told to stop`), its deferred calls
(`count: cleanup`), and returns. `stop` may be called any number of times, and after the
sequence has already ended. The documentation says: callers should typically `defer stop()`.

**It does not use a goroutine you manage.** Pull iterators are built on a coroutine, a
cheap switch between the caller and the iterator that does not run both at once . You get the effect of a producer without writing channels,
and without the data races: `next` and `stop` do not run concurrently, and you must not
call them from several goroutines at once.

**Panics travel.** If the iterator panics inside a call to `next` or `stop`, that call
panics with the same value, on your goroutine, where you can `recover`:

```go title="main.go"
package main

import (
	"fmt"
	"iter"
)

func Boom(yield func(int) bool) {
	yield(1)
	panic("boom in iterator")
}

func main() {
	next, stop := iter.Pull(iter.Seq[int](Boom))
	defer stop()
	fmt.Println(next())
	defer func() { fmt.Println("recovered:", recover()) }()
	fmt.Println(next())
}
```

```text
1 true
recovered: boom in iterator
```

## Always call stop

The rule: if you did not read `next` until it returned `false`, call `stop`. The simplest
habit is `defer stop()` right after `iter.Pull`, as `Merge` does. Calling `stop` twice is
fine, so you do not have to track which path ended the sequence:

```go title="main.go"
package main

import (
	"fmt"
	"iter"
)

func Count(n int) iter.Seq[int] {
	return func(yield func(int) bool) {
		for i := 1; i <= n; i++ {
			if !yield(i) {
				return
			}
		}
	}
}

func main() {
	next, stop := iter.Pull(Count(2))
	defer stop()
	for {
		v, ok := next()
		if !ok {
			break
		}
		fmt.Println(v)
	}
	v, ok := next() // after the end: zero value and false
	fmt.Println(v, ok)
	stop()
	stop() // calling stop again is fine
	fmt.Println("done")
}
```

```text
1
2
0 false
done
```

> [!WARNING]
> Forgetting `stop()` when you quit early. Symptom: an iterator that holds a resource (an open
> file, a lock, a database cursor) never runs its deferred cleanup, because it is suspended
> inside `yield` and nothing resumes it; the resource stays held. The program shows no error. Fix: `defer stop()`
> directly after `iter.Pull`.

## When to use Pull

Use a pull iterator when you must control the pace of an iterator yourself:

- merging, zipping or comparing two sequences (`Merge` above);
- a parser or state machine that asks for the next token only when its state needs one;
- a streaming `Next()` API that you must provide, built on an existing `iter.Seq`.

If one `for range` can do the job, use that: it is simpler, with no `stop` to forget and no
suspended iterator. The standard library offers `iter.Pull2` for `Seq2`, returning
`next func() (K, V, bool)`.

> [!NOTE]
> A pull iterator costs more per value than a range loop, since each `next` switches into
> the iterator and back. It is fine for merging a few streams; for a hot inner loop, write a
> push loop. Measure first ([[benchmarks]]).

[[slices-maps-pkgs]] has the ready-made functions that convert sequences to and from slices
and maps, so you rarely write `Pull` for those.
