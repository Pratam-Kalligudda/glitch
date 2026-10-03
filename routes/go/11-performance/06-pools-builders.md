---
title: Preallocation, Builder and sync.Pool
done_when: "You can cut allocations with make capacity hints, strings.Builder.Grow and sync.Pool, and prove each change with a benchmark that reports allocs/op."
---
Once a profile shows where a program allocates ([[pprof-heap]]), three techniques cover most fixes: **preallocate** when you know the size, build strings with a **`strings.Builder`** instead of `+=`, and **reuse** short-lived objects with **`sync.Pool`**. Each removes allocations, and each is measured the same way: a benchmark with `-benchmem` and a look at `allocs/op` ([[benchmarks]]).

The code below is one package, `alloc`, with the slow and fast version of each task side by side, followed by a benchmark file. The benchmarks store their results in package-level variables so the compiler cannot discard the work.

```go title="alloc.go"
package alloc

import (
	"bytes"
	"strconv"
	"strings"
	"sync"
)

// squares returns the first n squares, growing the slice as it goes.
func squares(n int) []int {
	var out []int
	for i := 0; i < n; i++ {
		out = append(out, i*i)
	}
	return out
}

// squaresPrealloc knows n up front, so it allocates once.
func squaresPrealloc(n int) []int {
	out := make([]int, 0, n)
	for i := 0; i < n; i++ {
		out = append(out, i*i)
	}
	return out
}

// joinPlus builds a string with +=: every step copies the whole string.
func joinPlus(parts []string) string {
	s := ""
	for _, p := range parts {
		s += p + ","
	}
	return s
}

// joinBuilder uses strings.Builder.
func joinBuilder(parts []string) string {
	var sb strings.Builder
	for _, p := range parts {
		sb.WriteString(p)
		sb.WriteByte(',')
	}
	return sb.String()
}

// joinBuilderGrow also reserves the final size first.
func joinBuilderGrow(parts []string) string {
	n := 0
	for _, p := range parts {
		n += len(p) + 1
	}
	var sb strings.Builder
	sb.Grow(n)
	for _, p := range parts {
		sb.WriteString(p)
		sb.WriteByte(',')
	}
	return sb.String()
}

// render formats a record into a fresh buffer every time.
func render(id int) []byte {
	var buf bytes.Buffer
	buf.WriteString("record ")
	buf.WriteString(strconv.Itoa(id))
	buf.WriteString(strings.Repeat("x", 1000))
	return buf.Bytes()
}

var bufPool = sync.Pool{
	New: func() any { return new(bytes.Buffer) },
}

// renderPooled reuses buffers through a sync.Pool and returns the length.
func renderPooled(id int) int {
	buf := bufPool.Get().(*bytes.Buffer)
	buf.Reset() // a pooled object keeps its old contents: always reset
	defer bufPool.Put(buf)
	buf.WriteString("record ")
	buf.WriteString(strconv.Itoa(id))
	buf.WriteString(strings.Repeat("x", 1000))
	return buf.Len()
}

// countWords fills a map without and with a size hint.
func countWords(words []string, hint bool) map[string]int {
	var m map[string]int
	if hint {
		m = make(map[string]int, len(words))
	} else {
		m = map[string]int{}
	}
	for _, w := range words {
		m[w]++
	}
	return m
}
```

```go title="alloc_test.go"
package alloc

import (
	"strconv"
	"testing"
)

var (
	sinkInts []int
	sinkStr  string
	sinkLen  int
	sinkMap  map[string]int
)

func parts() []string {
	p := make([]string, 1000)
	for i := range p {
		p[i] = "item" + strconv.Itoa(i)
	}
	return p
}

func BenchmarkSquares(b *testing.B) {
	for b.Loop() {
		sinkInts = squares(1000)
	}
}

func BenchmarkSquaresPrealloc(b *testing.B) {
	for b.Loop() {
		sinkInts = squaresPrealloc(1000)
	}
}

func BenchmarkJoinPlus(b *testing.B) {
	p := parts()
	b.ResetTimer()
	for b.Loop() {
		sinkStr = joinPlus(p)
	}
}

func BenchmarkJoinBuilder(b *testing.B) {
	p := parts()
	b.ResetTimer()
	for b.Loop() {
		sinkStr = joinBuilder(p)
	}
}

func BenchmarkJoinBuilderGrow(b *testing.B) {
	p := parts()
	b.ResetTimer()
	for b.Loop() {
		sinkStr = joinBuilderGrow(p)
	}
}

func BenchmarkRender(b *testing.B) {
	for b.Loop() {
		sinkLen = len(render(7))
	}
}

func BenchmarkRenderPooled(b *testing.B) {
	for b.Loop() {
		sinkLen = renderPooled(7)
	}
}

func BenchmarkMapNoHint(b *testing.B) {
	p := parts()
	b.ResetTimer()
	for b.Loop() {
		sinkMap = countWords(p, false)
	}
}

func BenchmarkMapHint(b *testing.B) {
	p := parts()
	b.ResetTimer()
	for b.Loop() {
		sinkMap = countWords(p, true)
	}
}
```

```bash
go test -bench . -benchmem -run '^$'
```

```text
goos: windows
goarch: amd64
pkg: example.com/alloc
cpu: 13th Gen Intel(R) Core(TM) i7-1355U
BenchmarkSquares-12            	  302532	      3623 ns/op	   25208 B/op	      12 allocs/op
BenchmarkSquaresPrealloc-12    	  811572	      2734 ns/op	    8192 B/op	       1 allocs/op
BenchmarkJoinPlus-12           	    1132	   2267103 ns/op	 4171766 B/op	    1000 allocs/op
BenchmarkJoinBuilder-12        	   47046	     22081 ns/op	   34296 B/op	      15 allocs/op
BenchmarkJoinBuilderGrow-12    	  178050	      7703 ns/op	    8192 B/op	       1 allocs/op
BenchmarkRender-12             	 1726125	       626.3 ns/op	    2112 B/op	       3 allocs/op
BenchmarkRenderPooled-12       	 4428286	       276.0 ns/op	    1024 B/op	       1 allocs/op
BenchmarkMapNoHint-12          	   18380	     65894 ns/op	  109016 B/op	      22 allocs/op
BenchmarkMapHint-12            	   33519	     35721 ns/op	   54656 B/op	       6 allocs/op
PASS
ok  	example.com/alloc	13.434s
```

Absolute times depend on your machine; the ratios and the `allocs/op` column are the lesson.

## Preallocate when you know the size

`append` doubles a slice's capacity when it is full and copies everything into the new array ([[slices-internals]], [[append-aliasing]]). Appending 1 000 values to a `nil` slice grew the array about a dozen times: 12 allocations, 25 208 bytes. `make([]int, 0, n)` reserves the capacity once: 1 allocation and 8 192 bytes (1 000 `int`s, rounded up to the allocator's size class), and about a quarter less time.

Use `make([]T, 0, n)` plus `append` when you fill the slice yourself; `make([]T, n)` plus indexing when you set every element. A map has the same issue: `make(map[string]int, n)` sizes it for `n` entries and avoids growing and rehashing. The map benchmark went from 22 to 6 allocations and from 65 µs to 36 µs. The hint is the number of entries you expect, an estimate is enough, and over-estimating wastes memory. When you do not know the size, do not guess wildly.

## Build strings with strings.Builder

A Go string is immutable. `s += x` makes a new string containing both and copies every byte every time, so building a string of `n` pieces costs O(n²). The `+=` version did **1 000 allocations and moved 4 MB** to build a 9 KB string, and took 2.3 ms. `strings.Builder` keeps a growing byte buffer and turns it into a string at the end with no extra copy: 15 allocations and 22 µs. Calling `Grow(n)` with the final size first (computed from the parts) reduces it to **1 allocation and 7.7 µs**: about 300 times faster than `+=`.

Rules for a `Builder`: write with `WriteString`, `WriteByte`, `WriteRune` and `fmt.Fprintf(&sb, ...)`; read with `String()`; do not copy a `Builder` after first use (it panics, to prevent two builders sharing one buffer). A single `+` in an expression such as `"a" + b + "c"` is fine, as the compiler makes one allocation for the whole expression; it is repeated `+=` in a loop that hurts. For joining a slice, `strings.Join(parts, ",")` already does the Grow trick and is the simplest choice ([[strings-pkg]]). `bytes.Buffer` is the same idea for `[]byte` ([[bytes-buffer]]).

## Reuse with sync.Pool

Some objects are expensive to allocate, are needed briefly and are needed constantly: buffers for each request, scratch slices, encoders. A **`sync.Pool`** is a cache of such objects. `Get` returns one from the pool or, if empty, calls `New` to make one; `Put` returns it for later use. Under concurrent use the pool keeps per-processor caches so the goroutines rarely contend.

`render` makes a new `bytes.Buffer` that grows to about 1 KiB on every call: 3 allocations and 2 112 bytes. `renderPooled` takes a buffer from the pool, resets it, uses it and returns it with a `defer`: after the first few calls, no buffer allocation, 1 allocation per call and 276 ns against 626 ns. (The remaining allocation is `strings.Repeat`, which builds the filler text, not the buffer.)

The rules that make a pool correct:

1. **Always reset what you `Get`.** A pooled object holds the data of its last user. `buf.Reset()` first; for a slice, `s = s[:0]`.
2. **Do not touch an object after `Put`.** It may already be in use by another goroutine. Copy out what you need first (the example returns `buf.Len()`, an integer, not `buf.Bytes()`, which would alias the pooled memory).
3. **The pool can empty at any time.** The garbage collector clears pools (an object survives roughly two GC cycles unused), so never store state you need in a pool. It is a cache, never a source of truth.
4. **Do not pool tiny or cheap objects.** The `Get` and `Put` calls cost more than allocating a 16-byte struct. Pool buffers and large scratch memory.
5. **Do not pool objects of unbounded size.** One huge request grows a buffer; returned to the pool, it stays huge. Drop oversized objects instead of putting them back, as the standard library's `fmt` does.

> [!WARNING]
> Skipping the reset, or using an object after `Put`, causes the worst kind of bug: wrong data, intermittent, only under load. Symptom: a response body that contains a fragment of another request's data, or a corrupted record that never happens in a single-threaded test. Fix: reset immediately after `Get`; copy before `Put`; test with the race detector (`go test -race`, [[coverage-race]]). A second mistake is optimising by reflex: wrapping every allocation in a pool, which adds complexity for no measured gain. Add one only when a heap profile shows the allocation matters and the benchmark shows `allocs/op` falling.

> [!NOTE]
> The three techniques share a principle: **know the size or reuse the memory**. The same idea appears in `bufio` (a fixed buffer around a reader, [[bufio]]), `strings.Builder.Grow`, `slices.Grow` and `make` with a capacity. For the allocations the compiler decides ([[escape-analysis]]), you do not control them directly, but passing a destination (`func appendRecord(dst []byte, r Record) []byte`) lets the caller reuse a buffer, which is the pattern behind `strconv.AppendInt` and `time.Time.AppendFormat`.

linkcheck builds its benchmark page with a `strings.Builder` in [[step-9-profile]]; the profile there points at tokenizing instead of a pool, so it uses no `sync.Pool`.
