---
title: Allocation and escape analysis
done_when: "You can read -gcflags=-m output, say why a value was moved to the heap, and confirm the cost with a benchmark that reports allocations."
---
Go has two places to keep a value. The **stack** belongs to one function call: allocating there means moving a pointer, and the memory vanishes when the function returns, at no cost to the garbage collector. The **heap** is shared, long-lived memory: allocating takes more work, and the garbage collector must later find and free the value. Programs run faster when fewer values go on the heap.

You do not choose. Go has no `stack` or `heap` keyword, and `new(T)` and `&T{}` do not mean "heap". The compiler runs **escape analysis**: for each value it asks whether anything could still refer to it after the function that created it returns. If not, it stays on the stack. If so, or if the compiler cannot prove otherwise, the value **escapes** to the heap. The program behaves the same either way; only speed and garbage collector load change.

## Asking the compiler

`go build -gcflags=-m` prints the compiler's decisions. This file has seven small functions, each marked `//go:noinline` so the compiler keeps them as separate calls and the output stays about one function at a time (the compiler normally merges small functions into their callers, called **inlining**):

```go title="main.go"
package main

import "fmt"

type Point struct{ X, Y int }

// byValue returns a copy: the Point never needs the heap.
//go:noinline
func byValue(x, y int) Point {
	p := Point{x, y}
	return p
}

// byPointer returns the address of a local: it must outlive the call.
//go:noinline
func byPointer(x, y int) *Point {
	p := Point{x, y}
	return &p
}

// sumLocal uses a local array that stays on the stack.
//go:noinline
func sumLocal() int {
	var buf [64]int
	for i := range buf {
		buf[i] = i
	}
	total := 0
	for _, v := range buf {
		total += v
	}
	return total
}

// makeSlice has a size known only at run time.
//go:noinline
func makeSlice(n int) []int {
	s := make([]int, n)
	return s[:n/2]
}

// fixedSlice has a constant size and does not leave the function.
//go:noinline
func fixedSlice() int {
	s := make([]int, 8)
	s[0] = 1
	return s[0]
}

// boxed passes a value through an interface: fmt.Println takes ...any.
//go:noinline
func boxed(n int) {
	fmt.Println("value:", n)
}

// counter returns a closure that captures count.
//go:noinline
func counter() func() int {
	count := 0
	return func() int {
		count++
		return count
	}
}

func main() {
	byValue(1, 2)
	byPointer(3, 4)
	sumLocal()
	makeSlice(10)
	fixedSlice()
	boxed(7)
	counter()()
}
```

```bash
go build -gcflags=-m -o esc .
```

```text
# example.com/escape
./main.go:60:9: can inline counter.func1
./main.go:53:13: inlining call to fmt.Println
./main.go:17:2: moved to heap: p
./main.go:38:11: make([]int, n) escapes to heap
./main.go:45:11: make([]int, 8) does not escape
./main.go:53:13: ... argument does not escape
./main.go:53:14: "value:" escapes to heap
./main.go:53:24: n escapes to heap
./main.go:59:2: moved to heap: count
./main.go:60:9: func literal escapes to heap
```

Each line is `file:line:column: message`. Reading them against the source:

| Line | Message | Why |
|---|---|---|
| 17 | `moved to heap: p` | `byPointer` returns `&p`. The caller uses the `Point` after the function ended, so it cannot live in the function's stack frame |
| 38 | `make([]int, n) escapes to heap` | `makeSlice` returns part of the slice, and `n` is not a constant, so the size is unknown at compile time |
| 45 | `make([]int, 8) does not escape` | constant size, never leaves `fixedSlice`: stack |
| 53 | `"value:" escapes to heap`, `n escapes to heap` | passing a value as `any` stores it in an interface, and `fmt.Println`'s parameters may be kept; each argument is boxed on the heap |
| 59 | `moved to heap: count` | the returned closure still refers to `count` after `counter` returns |
| 60 | `func literal escapes to heap` | the closure value itself is returned |

Nothing is reported for `byValue` and `sumLocal`: no message means the values stay on the stack. `byValue` returns a copy of `p`, which is fine; a 64-element array fits comfortably. `... argument does not escape` means the slice that holds `fmt.Println`'s variadic arguments is on the stack; it is the values inside that were boxed.

A second `-m` (`-gcflags='-m -m'`) explains each decision with the chain of reasoning. For `count` it ends with the line `from count (reference) at ./main.go:61:3`: the closure body refers to the variable.

## Measuring the difference

A decision on the heap costs time and creates garbage. A benchmark with `-benchmem` shows both. `b.Loop()` ([[benchmarks]]) runs the body repeatedly; the package-level sink variables stop the compiler from deleting the work:

```go title="main_test.go"
package main

import "testing"

var sink *Point
var sinkVal Point

func BenchmarkByValue(b *testing.B) {
	for b.Loop() {
		sinkVal = byValue(1, 2)
	}
}

func BenchmarkByPointer(b *testing.B) {
	for b.Loop() {
		sink = byPointer(1, 2)
	}
}

func BenchmarkMakeSlice(b *testing.B) {
	for b.Loop() {
		_ = makeSlice(1000)
	}
}

func BenchmarkFixedSlice(b *testing.B) {
	for b.Loop() {
		_ = fixedSlice()
	}
}
```

```bash
go test -bench . -benchmem -run '^$'
```

```text
goos: windows
goarch: amd64
pkg: example.com/escape
cpu: 13th Gen Intel(R) Core(TM) i7-1355U
BenchmarkByValue-12       	1000000000	         1.017 ns/op	       0 B/op	       0 allocs/op
BenchmarkByPointer-12     	63924313	        18.21 ns/op	      16 B/op	       1 allocs/op
BenchmarkMakeSlice-12     	  384098	      3480 ns/op	    8192 B/op	       1 allocs/op
BenchmarkFixedSlice-12    	1000000000	         0.7998 ns/op	       0 B/op	       0 allocs/op
PASS
ok  	example.com/escape	4.744s
```

Your numbers will differ with the processor; the pattern will not. The `-run '^$'` matches no test so only the benchmarks run. `allocs/op` is the number of heap allocations per call and `B/op` the bytes. `byValue` makes none and takes about a nanosecond; `byPointer` makes one 16-byte allocation and takes about eighteen times longer, plus the time the garbage collector later spends on it. `makeSlice(1000)` allocates 8 000 bytes (1 000 `int`s) rounded up to the allocator's size class of 8 192.

## How it works: the rules the compiler applies

A value escapes when the compiler cannot prove that every reference to it dies with the function. The common causes:

1. **A pointer to it is returned or stored somewhere that outlives the call**: a returned `&x`, a store into a field of something longer-lived, a send on a channel, an append to a slice that escapes.
2. **It is captured by a closure that escapes** (returned, started with `go`, stored).
3. **It is converted to an interface** whose contents may outlive the call (the `fmt.Println` case). Small values such as 0 to 255 and constants avoid the allocation, but most values do not.
4. **Its size is not known at compile time**: `make([]T, n)` with a variable `n`, and very large values (the limit for an implicit stack variable is 64 KiB; `make` of a constant size over 64 KiB also goes to the heap).
5. **A function it is passed to lets it escape** (the callee's analysis propagates to the caller), or the compiler cannot see the callee: a call through an interface method or a function value is opaque, so its arguments are assumed to escape.

Two things that are **not** reasons: a value being large-ish (up to the limits above) and the use of `new` or `&T{}` for a value that stays local. `p := &Point{1, 2}` used only inside the function stays on the stack.

**Stacks grow.** A goroutine's stack starts small and the runtime enlarges it when a deep call chain needs more, copying it elsewhere. That is why Go can keep many goroutines ([[goroutines]]) and why stack values need no manual management.

> [!WARNING]
> Optimising allocations before measuring is the usual mistake, and it makes code worse: contorted APIs that pass pointers in to "avoid allocating" and are slower, or value copies of big structs that cost more than the allocation they save. Symptom: unreadable code and a benchmark that did not move. Fix: profile first ([[pprof-cpu]], [[pprof-heap]]), find the function that allocates most, check it with `-gcflags=-m`, change one thing and rerun the benchmark with `-benchmem`. Passing a pointer into a function is not a cost by itself; returning a pointer to a fresh value is what forces the heap.

> [!NOTE]
> Escape decisions are per build and can change with compiler versions and with inlining. Never rely on a value staying on the stack for correctness, only for speed. To see why a value escapes use `-gcflags='-m -m'`; to see only one package use `go build -gcflags='example.com/escape=-m'`. Allocation-heavy designs, such as many small short-lived pointers in a hot loop, are what the garbage collector's cost scales with ([[gc-tuning]]).

The standard ways to allocate less are collected in [[pools-builders]]: preallocating slices, using `strings.Builder` and reusing buffers. linkcheck cuts its allocations in [[step-9-profile]] by streaming a page through the tokenizer instead of building a tree.
