---
title: Every form of range
done_when: "You can say, for each type you can range over, what the loop variables are, when the range expression is evaluated, and what happens if the collection changes during the loop."
---
`for ... range` loops over a collection. What the variables mean depends on the type of the
**range expression**, the value after `range`. This stop lists every form, then the rules
that surprise people: when the expression is evaluated, what the variable is a copy of, and
what you may change inside the loop. Ranging over functions has its own stops, starting with
[[range-func]].

```go title="main.go"
package main

import (
	"fmt"
	"sort"
)

func main() {
	// slice: index and element copy
	for i, v := range []string{"a", "b"} {
		fmt.Println("slice", i, v)
	}

	// string: byte index of each rune, and the rune
	for i, r := range "héy" {
		fmt.Printf("string %d %q %d\n", i, r, r)
	}
	// invalid UTF-8 yields U+FFFD, advancing one byte
	for i, r := range "a\xffb" {
		fmt.Printf("bad %d %U\n", i, r)
	}

	// map: key and value, order unspecified
	m := map[string]int{"x": 1, "y": 2, "z": 3}
	var keys []string
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	fmt.Println("map keys sorted", keys)

	// integer (Go 1.22): 0..n-1
	for i := range 3 {
		fmt.Println("int", i)
	}
	// no variable at all
	n := 0
	for range 4 {
		n++
	}
	fmt.Println("count", n)

	// channel: one value, until closed
	ch := make(chan int, 3)
	ch <- 10
	ch <- 20
	close(ch)
	for v := range ch {
		fmt.Println("chan", v)
	}

	// pointer to array
	arr := [3]int{1, 2, 3}
	for i, v := range &arr {
		fmt.Println("arrptr", i, v)
	}
}
```

```bash
go run .
```

```text
slice 0 a
slice 1 b
string 0 'h' 104
string 1 'é' 233
string 3 'y' 121
bad 0 U+0061
bad 1 U+FFFD
bad 2 U+0062
map keys sorted [x y z]
int 0
int 1
int 2
count 4
chan 10
chan 20
arrptr 0 1
arrptr 1 2
arrptr 2 3
```

## The forms

| Range expression | First variable | Second variable | Ends when |
|---|---|---|---|
| array, pointer to array, slice | index `int` | element (a copy) | last index |
| string | byte index of the rune | the rune (`rune`) | end of string |
| map | key | value | all entries visited |
| channel | element | none (only one variable allowed) | channel closed and drained |
| integer `n` | `0` up to `n-1`, of `n`'s type | none | `n-1` |
| function (Go 1.23) | what the function yields | | the function returns |

Every variable is optional: drop the second (`for i := range s`), or both (`for range s`).
Use `_` to skip the first and keep the second.

**Strings yield runes, not bytes.** The index is a byte offset: `é` takes two bytes, so the
index jumps from 1 to 3. An invalid byte sequence yields `U+FFFD` (the replacement character)
and advances one byte, as the `"a\xffb"` loop shows. Ranging over bytes needs
`for i := 0; i < len(s); i++`. The details are in [[strings-runes]].

**Integers (Go 1.22).** `for i := range n` runs `n` times with `i` from `0` to `n-1`. If `n`
is `0` or negative the body does not run. The type of `i` is the type of `n`, and the
range expression must be an integer: a float constant is an error.

```go title="main.go"
package main

import "fmt"

func main() {
	for i := range 3.5 {
		fmt.Println(i)
	}
	for a, b := range 5 {
		fmt.Println(a, b)
	}
}
```

```text
./main.go:6:17: cannot range over 3.5 (untyped float constant)
./main.go:9:9: range over 5 (untyped int constant) permits only one iteration variable
```

**Maps have no order, on purpose.** The runtime starts the loop at a random point and the
order changes between runs. Running a program that prints the keys of one four-key map
several times printed, for example:

```text
a b c d
d a b c
```

Never depend on map order. To get a stable order, collect the keys, sort them, and loop over
the sorted slice; [[slices-maps-pkgs]] shows `slices.Sorted(maps.Keys(m))`, and [[maps]]
covers maps in depth.

**Channels** yield values until the channel is closed and drained, then the loop ends. They
allow only one variable, because a receive produces one value. A `range` over a channel
nobody closes blocks forever: see [[channels]].

## When the range expression is evaluated

The range expression is evaluated **once**, before the loop starts. What that means depends
on the type:

```go title="main.go"
package main

import "fmt"

func main() {
	// An array is copied: changes to arr are not seen by the loop.
	arr := [3]int{1, 2, 3}
	for i, v := range arr {
		if i == 0 {
			arr[2] = 99
		}
		fmt.Print(v, " ")
	}
	fmt.Println(arr)

	// Ranging over &arr (or a slice) sees the changes.
	arr = [3]int{1, 2, 3}
	for i, v := range &arr {
		if i == 0 {
			arr[2] = 99
		}
		fmt.Print(v, " ")
	}
	fmt.Println()

	// For a slice the length is fixed up front, so appends are not visited.
	s := []int{1, 2, 3}
	for _, v := range s {
		s = append(s, v*10)
	}
	fmt.Println(s)

	// The element variable is a copy: modifying it does not change the slice.
	type P struct{ N int }
	ps := []P{{1}, {2}}
	for _, p := range ps {
		p.N *= 10
	}
	fmt.Println(ps)
	for i := range ps {
		ps[i].N *= 10
	}
	fmt.Println(ps)
}
```

```text
1 2 3 [1 2 99]
1 2 99 
[1 2 3 10 20 30]
[{1} {2}]
[{10} {20}]
```

- **Arrays are values**, so `range arr` loops over a copy; the loop printed `3` even though
  `arr[2]` became `99`. A pointer to an array (or a slice) shares memory with the original,
  so the loop sees the new value (`99`). Ranging over a large array by value copies it; use
  `&arr` or a slice for large ones.
- **A slice's length is read once.** Appending inside the loop does not make it run longer:
  the loop visited three values and `s` ended with six. The slice header was copied, so
  after an `append` that reallocates, the loop still reads the old backing array
  ([[append-aliasing]]).
- **The element variable is a copy of the element.** Assigning to `p.N` changed the copy.
  To modify elements, index into the slice: `ps[i].N`. Ranging with the index alone also
  avoids copying a large struct on every iteration.

## Changing a map while ranging

Deleting entries while ranging a map is allowed, and entries deleted before they are reached
are not produced:

```go title="main.go"
package main

import "fmt"

func main() {
	m := map[int]bool{1: true, 2: true, 3: true, 4: true}
	for k := range m {
		delete(m, k)
	}
	fmt.Println(len(m))
}
```

```text
0
```

Inserting during the loop is also allowed, but an entry you add may or may not be visited by
that same loop; which is unspecified. Do not add keys to a map while ranging over it unless
the code is correct either way.

> [!WARNING]
> Expecting the loop to see changes to what you range over. Symptoms: an array loop that
> shows stale values, a slice loop that does not process items you appended, and
> `for _, v := range items { v.Count++ }` leaving `items` unchanged. Fix: range over `&arr`
> or a slice to see in-place changes; use the index (`items[i].Count++`) to modify elements;
> collect additions in a separate slice and append after the loop.

> [!NOTE]
> The `range` loop is defined in the spec section "For statements with range clauses":
> <https://go.dev/ref/spec#For_range>.

What `i` and `v` are in each iteration, and why that matters when a goroutine or closure
captures them, is next: [[loop-variables]].
