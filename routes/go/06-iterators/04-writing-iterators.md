---
title: Writing iterators
done_when: "You have written an iterator method, an adaptor that takes and returns an iterator, and an iterator that reports errors, and each one stops when yield returns false."
---
[[range-func]] showed the mechanism. Writing good iterators is mostly four patterns: a
method that returns an iterator over a data structure, an iterator that has no end, an
**adaptor** that wraps one iterator in another, and an iterator that can fail. Each follows
one rule: call `yield` for each value and **stop as soon as it returns `false`**.

```go title="main.go"
package main

import (
	"fmt"
	"iter"
	"strings"
)

// Tree is a binary search tree.
type Tree[T any] struct {
	Left, Right *Tree[T]
	Val         T
}

// All walks the tree in order. The recursion passes yield down and
// stops everything as soon as yield returns false.
func (t *Tree[T]) All() iter.Seq[T] {
	return func(yield func(T) bool) {
		t.push(yield)
	}
}

func (t *Tree[T]) push(yield func(T) bool) bool {
	if t == nil {
		return true
	}
	return t.Left.push(yield) && yield(t.Val) && t.Right.push(yield)
}

// Filter and Take are adaptors: they take an iterator and return one.
func Filter[V any](seq iter.Seq[V], keep func(V) bool) iter.Seq[V] {
	return func(yield func(V) bool) {
		for v := range seq {
			if keep(v) && !yield(v) {
				return
			}
		}
	}
}

func Take[V any](seq iter.Seq[V], n int) iter.Seq[V] {
	return func(yield func(V) bool) {
		if n <= 0 {
			return
		}
		i := 0
		for v := range seq {
			if !yield(v) {
				return
			}
			i++
			if i == n {
				return
			}
		}
	}
}

// Naturals never ends: the consumer decides when to stop.
func Naturals() iter.Seq[int] {
	return func(yield func(int) bool) {
		for i := 0; ; i++ {
			if !yield(i) {
				return
			}
		}
	}
}

// Lines yields the lines of s with their numbers.
func Lines(s string) iter.Seq2[int, string] {
	return func(yield func(int, string) bool) {
		n := 0
		for line := range strings.SplitSeq(s, "\n") {
			n++
			if !yield(n, line) {
				return
			}
		}
	}
}

func main() {
	t := &Tree[int]{
		Left:  &Tree[int]{Val: 1, Right: &Tree[int]{Val: 2}},
		Val:   3,
		Right: &Tree[int]{Val: 5, Left: &Tree[int]{Val: 4}},
	}
	for v := range t.All() {
		fmt.Print(v, " ")
	}
	fmt.Println()

	even := Filter(Naturals(), func(n int) bool { return n%2 == 0 })
	for v := range Take(even, 4) {
		fmt.Print(v, " ")
	}
	fmt.Println()

	for n, line := range Lines("alpha\nbeta\ngamma") {
		if n == 3 {
			break
		}
		fmt.Printf("%d: %s\n", n, line)
	}
}
```

```bash
go run .
```

```text
1 2 3 4 5 
0 2 4 6 
1: alpha
2: beta
```

## How it works

**Return the iterator from a method named `All`.** Types in the standard library that can be
walked do this: `slices.All`, `maps.All`, and by convention a method such as `(*Tree).All()`
returns `iter.Seq[T]`. A type with several traversals uses descriptive names (`Backward`,
`Keys`, `Values`). The method does no work until the caller ranges over the result, so
creating the iterator is cheap and it can be ranged over more than once.

**Recursion passes `yield` down and propagates its `false`.** `push` returns `bool`: whether
to continue. `t.Left.push(yield) && yield(t.Val) && t.Right.push(yield)` visits left, then
the node, then right, and the `&&` chain short-circuits: when `yield` returns `false`, the
right subtree is never visited and every caller up the stack returns `false` too. Do not
write a recursive iterator that creates a new `iter.Seq` per level; pass the one `yield`.

**An iterator may be infinite.** `Naturals` has no end condition other than `yield` returning
false. The consumer stops it with `break`, or an adaptor stops it. That is safe only because
`Naturals` checks `yield`. Infinite iterators make the check non-optional.

**An adaptor takes an iterator and returns one.** `Filter` ranges over `seq` inside its own
returned function, so the loop in `main` is the outermost body, and a `break` there unwinds
through `Take`, `Filter` and `Naturals`: `yield` returns `false` in each one, each returns.
`Take` stops after `n` values without asking for the `n+1`th, which matters for infinite
sources: asking one more could run forever. Adaptors are lazy: nothing runs until the loop,
and no intermediate slice exists.

**Choose `Seq` or `Seq2` by what the pair means.** `Lines` yields a line number and the line,
like `slices.All`'s index and value. A `Seq2[K, V]` over a map-like thing yields key and
value. A `Seq2[T, error]` reports failures, as the next section shows.

## Iterators that can fail

An iterator cannot return an error, because the loop's value is consumed by the loop. Two
conventions exist. The first yields the error as part of the sequence: `iter.Seq2[T, error]`.
After yielding an error, the iterator normally stops.

```go title="main.go"
package main

import (
	"bufio"
	"fmt"
	"iter"
	"os"
	"strings"
)

// FileLines yields each line of a file. An error is yielded as the second
// value; after yielding an error, the iterator stops.
func FileLines(path string) iter.Seq2[string, error] {
	return func(yield func(string, error) bool) {
		f, err := os.Open(path)
		if err != nil {
			yield("", err)
			return
		}
		defer f.Close() // runs when the loop ends, even on break

		sc := bufio.NewScanner(f)
		for sc.Scan() {
			if !yield(sc.Text(), nil) {
				return
			}
		}
		if err := sc.Err(); err != nil {
			yield("", err)
		}
	}
}

func main() {
	os.WriteFile("words.txt", []byte("go\nrust\nzig\n"), 0o644)
	defer os.Remove("words.txt")

	for line, err := range FileLines("words.txt") {
		if err != nil {
			fmt.Println("error:", err)
			break
		}
		fmt.Println(strings.ToUpper(line))
	}

	for _, err := range FileLines("missing.txt") {
		fmt.Println("error:", err)
	}
}
```

```text
GO
RUST
ZIG
error: open missing.txt: The system cannot find the file specified.
```

The last line is the Windows wording; Linux and macOS print `no such file or directory`.

Resource cleanup belongs in the iterator with `defer`. It runs when the iterator returns,
which happens when the loop ends or `break`s ([[defer]]), so the file is closed in every
case. An iterator also never has to hold the whole input in memory, which a function that returns
a slice does.

The second convention gives the iterator an `Err()` method, as `bufio.Scanner` does: the
loop yields values, and the caller checks `Err()` after the loop. Prefer `Seq2[T, error]` when
errors can occur per item and the caller must act at each; both are used in practice.

## Design rules

- Call `yield` only inside the iterator function, from the goroutine that runs it, and never
  after it returned `false`.
- Do the setup (open the file, take the lock) inside the returned function, not when you
  create the iterator, so the iterator can be ranged over again and cleanup is paired.
- Document whether the iterator can be ranged over more than once, and what happens if the
  data changes during the loop. `Tree.All` follows the tree as it is at each step; if the
  tree changes during the loop, that is the caller's bug unless you say otherwise.
- Prefer returning `iter.Seq` from a method over exposing a callback `Each`: callers get
  `break`, `return` and `defer` for free.

> [!WARNING]
> Not stopping after `yield` returns `false`, in a helper or recursion you did not think of.
> Symptom: the panic `range function continued iteration after function for loop body
> returned false`, only when a caller breaks. A recursive iterator is the usual culprit:
> the child call ignores the result and the parent keeps going. Fix: make the helper return
> a `bool`, and return `false` up the whole chain as `push` does.

> [!NOTE]
> Before writing an adaptor, check `slices` and `maps`: `slices.Values`, `slices.Collect`,
> `slices.Sorted`, `maps.Keys` and others already convert between slices, maps and
> iterators ([[slices-maps-pkgs]]). The `iter` package itself has only `Seq`, `Seq2`, `Pull` and `Pull2`, so write the
> small adaptors you need, as above.

linkcheck's `Report` type yields its results as `iter.Seq` values that the reporters range
over in [[step-7-reporters]].
