---
title: What copies and what shares
done_when: "For each field of a struct you wrote, you can say whether `b := a` copies it or shares it, and `go vet ./...` reports no copied locks."
---
Every assignment in Go copies a value: `b := a`, passing an argument, returning a result,
the variables of a `range` loop, storing into a slice, map, channel or interface. There
are no exceptions and no hidden references. The surprises come from what a value
*contains*. Some types hold their data directly, so copying them copies the data. Others
are small headers that point at data elsewhere, so copying them copies the pointer, and the
two copies **share** the data. This stop pulls together what the earlier stops showed one
type at a time into one rule you can apply to any type.

## One struct, five kinds of field

```go title="main.go"
package main

import (
	"fmt"
	"maps"
	"slices"
)

type Report struct {
	Title  string
	Counts [3]int         // array: copied
	Links  []string       // slice header copied, elements shared
	Status map[string]int // map: shared
	Owner  *string        // pointer: shared target
}

func main() {
	owner := "ana"
	a := Report{
		Title:  "daily",
		Counts: [3]int{1, 2, 3},
		Links:  []string{"/a", "/b"},
		Status: map[string]int{"/a": 200},
		Owner:  &owner,
	}

	b := a // copy the struct
	b.Title = "weekly"
	b.Counts[0] = 100
	b.Links[0] = "/changed"
	b.Status["/a"] = 500
	*b.Owner = "bo"
	b.Links = append(b.Links, "/c")

	fmt.Println(a.Title, a.Counts, a.Links, a.Status, *a.Owner)
	fmt.Println(b.Title, b.Counts, b.Links, b.Status, *b.Owner)

	// A deep enough copy: clone each reference-like field.
	c := a
	c.Links = slices.Clone(a.Links)
	c.Status = maps.Clone(a.Status)
	o := *a.Owner
	c.Owner = &o
	c.Links[0] = "/only-c"
	c.Status["/a"] = 404
	fmt.Println(a.Links, a.Status, c.Links, c.Status)

	reports := []Report{a}
	for _, r := range reports {
		r.Title = "lost" // r is a copy
	}
	fmt.Println(reports[0].Title)
}
```

```bash
go run .
```

```text
daily [1 2 3] [/changed /b] map[/a:500] bo
weekly [100 2 3] [/changed /b /c] map[/a:500] bo
[/changed /b] map[/a:500] [/only-c /b] map[/a:404]
daily
```

## How it works

`b := a` copied the `Report` field by field, bit for bit. What each field's bits are
decides what happened next:

- `Title` is a string header pointing at immutable bytes. The bytes are shared, but since
  nobody can change them, setting `b.Title` just pointed `b`'s header elsewhere. Behaves
  like a copy.
- `Counts` is an array: the three ints are inside the struct, so `b` got its own three.
  `b.Counts[0] = 100` did not touch `a`.
- `Links` is a slice header: pointer, length, capacity ([[slices-internals]]). Both headers
  point at the same backing array, so `b.Links[0] = "/changed"` is visible through `a`. Then
  `append` on `b.Links` changed only `b`'s header (here it also had to allocate, since the
  capacity was 2), so `a` still has two links. That half-shared state is exactly what
  [[append-aliasing]] warned about.
- `Status` is a map: the map value is a pointer to the runtime's table ([[maps]]). Fully
  shared.
- `Owner` is a pointer: copied pointer, same target. `*b.Owner = "bo"` changed what `a`
  sees too.

The `range` loop is the same rule again: `r` is a copy of each element, so `r.Title =
"lost"` changed the copy. Loop by index, or store pointers, to modify elements.

### The rule for every type

| Type | A copy gets | After `b := a`, writing through `b` |
|---|---|---|
| Numbers, `bool` | The value | Never affects `a` |
| `string` | Header; bytes are immutable | Never affects `a` |
| Array `[N]T` | All N elements, copied by these same rules | Elements: never; what they point to: yes |
| Struct | Every field, copied by these same rules | Depends on each field |
| Pointer `*T` | The address | Writes through it affect `a`'s target |
| Slice | Header (pointer, len, cap) | Element writes affect `a`; `append` may or may not |
| Map | Reference to the table | Always affects `a` |
| Channel | Reference to the channel | Same channel (see [[channels]]) |
| Function | Reference to code and captured variables | Calls share captured variables |
| Interface | Type and a copy of the dynamic value | The stored value is a copy; if it is a pointer, the target is shared (see [[interface-values]]) |

Copying is always **shallow**: Go never follows pointers to copy what they point to.
`slices.Clone` and `maps.Clone` are shallow too: cloning a `map[string][]string` gives a new
map whose values are the same slice headers, still sharing backing arrays. A **deep copy**
is code you write for your type, cloning each level that must be independent, as `c` above
does for each field.

## Values that must not be copied

Some types are only correct at one address: `sync.Mutex`, `sync.WaitGroup`,
`strings.Builder`, `sync/atomic` types. Copying a locked mutex copies its locked state;
copying a `WaitGroup` splits its counter in two. The compiler allows the copy; `go vet`
catches it:

```go title="locks/main.go"
package main

import (
	"fmt"
	"sync"
)

type Stats struct {
	mu    sync.Mutex
	pages int
}

func (s *Stats) Add() {
	s.mu.Lock()
	s.pages++
	s.mu.Unlock()
}

func snapshot(s Stats) int { return s.pages }

func main() {
	all := []Stats{{}, {}}
	for _, s := range all {
		s.Add()
	}
	first := all[0]
	fmt.Println(snapshot(first), all[0].pages)
}
```

```text
0 0
```

```bash
go vet ./locks
```

```text
locks\main.go:19:17: snapshot passes lock by value: example.com/copying/locks.Stats contains sync.Mutex
locks\main.go:23:9: range var s copies lock: example.com/copying/locks.Stats contains sync.Mutex
locks\main.go:26:11: assignment copies lock value to first: example.com/copying/locks.Stats contains sync.Mutex
locks\main.go:27:23: call of snapshot copies lock value: example.com/copying/locks.Stats contains sync.Mutex
```

Each report is a place where a `Stats` was copied: a value parameter, a `range` variable,
an assignment, a call. The program printed `0 0` because `Add` incremented copies made by
the `range`. Pass `*Stats`, range by index, and store `[]*Stats` when the elements carry
locks.

> [!WARNING]
> Treating a struct copy as an independent snapshot is the common mistake. The symptom is a
> "copy" whose slice elements or map entries change when the original is modified, or the
> reverse, a report built from a copy that mutates live data. Decide per field: arrays and
> plain values copy; slices, maps, pointers, channels and functions share. When you need an
> independent copy, write a `Clone` method that clones every sharing field, and run
> `go vet` to catch copies of types that must not be copied at all.

> [!NOTE]
> Copying is also what makes passing values to goroutines safe or unsafe: a copied `int` is
> private to the goroutine, a copied slice header is not. That distinction is the starting
> point of [[memory-model]].

When linkcheck saves its crawl state in [[step-8-state]], ask of every field it writes out
whether it is a copy or shared with code that is still changing it.
