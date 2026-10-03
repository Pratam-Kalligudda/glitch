---
title: append, aliasing and the full slice expression
---
Two slices **alias** each other when they share a backing array: a write through one is
visible through the other. You saw in [[slices-internals]] that slicing never copies, and
that `append` writes in place when there is spare capacity and allocates a new array when
there is not. Put together, that means whether two slices alias after an `append` depends
on a number you rarely look at, the capacity. This stop shows the bugs that come from it
and the three tools that prevent them: assigning `append`'s result, the **full slice
expression** `s[low:high:max]`, and `slices.Clone`.

## Two appends, one slot

```go title="main.go"
package main

import (
	"fmt"
	"slices"
)

func main() {
	base := make([]string, 3, 4)
	copy(base, []string{"/", "/about", "/blog"})

	a := append(base, "/a") // fits in capacity: writes base's array
	b := append(base, "/b") // also fits: overwrites the same slot
	fmt.Println(a, b)

	c := append(a, "/c") // a is full: c gets a new array
	c[0] = "/home"
	fmt.Println(a[0], c[0])

	// The full slice expression caps the capacity, so append must copy.
	limited := base[:3:3]
	d := append(limited, "/d")
	e := append(limited, "/e")
	fmt.Println(d, e)

	// slices.Clone makes an independent copy.
	f := slices.Clone(base)
	f[0] = "/root"
	fmt.Println(base[0], f[0])
}
```

```bash
go run .
```

```text
[/ /about /blog /b] [/ /about /blog /b]
/ /home
[/ /about /blog /d] [/ /about /blog /e]
/ /root
```

## How it works

Walk through it with the headers in mind. `base` has length 3 and capacity 4: one free
slot at index 3.

1. `append(base, "/a")` sees room, writes `"/a"` into index 3 of base's array, and returns a
   header (same pointer, length 4). `a` aliases `base`.
2. `append(base, "/b")` starts from `base`, which still has length 3. There is still room
   at index 3, so it writes `"/b"` there, over `"/a"`. `a` and `b` are the same four
   elements, and `a` "changed" without anyone touching it.
3. `append(a, "/c")` finds `a` full (length 4, capacity 4), allocates a new array, copies,
   and appends. `c` no longer aliases `a`, so `c[0] = "/home"` leaves `a[0]` alone.

The rule: **after `x := append(s, v)`, `x` and `s` share memory if and only if `s` had spare
capacity.** You cannot tell from the code, only from the capacity at run time.

### The full slice expression

`s[low:high:max]` slices like `s[low:high]` but also sets the capacity to `max - low`.
`base[:3:3]` has length 3 and capacity 3, so every `append` to it must allocate. `d` and
`e` got separate arrays and did not collide. Capping the capacity is how you hand someone
a slice they can append to without writing into your memory. `max` may not exceed the
original capacity.

### slices.Clone

`slices.Clone(s)` allocates a new backing array of length `len(s)` and copies the
elements. Use it when you need an independent copy to keep or modify. It is shallow: if the
elements are pointers, maps or slices themselves, the copy shares what they point to (see
[[copying]]).

### append must be assigned

`append` cannot change the caller's header; it returns a new one. The compiler insists you
use it:

```text
e\e.go:4:2: append(s, 1) (value of type []int) is not used
```

## The same bug in real code

A crawler that records how it reached each page builds a path slice as it recurses:

```go title="crawl/main.go"
package main

import "fmt"

// visit records the chain of pages that led to each page.
func visit(path []string, page string, links map[string][]string, out map[string][]string) {
	path = append(path, page)
	out[page] = path
	for _, next := range links[page] {
		visit(path, next, links, out)
	}
}

func addPage(pages []string, p string) {
	pages = append(pages, p)
}

func main() {
	links := map[string][]string{
		"/":           {"/docs"},
		"/docs":       {"/docs/guide"},
		"/docs/guide": {"/docs/guide/a", "/docs/guide/b"},
	}
	out := map[string][]string{}
	visit(nil, "/", links, out)
	fmt.Println(out["/docs/guide/a"])
	fmt.Println(out["/docs/guide/b"])

	pages := make([]string, 0, 10)
	addPage(pages, "/new")
	fmt.Println(len(pages), pages[:1])
}
```

```text
[/ /docs /docs/guide /docs/guide/b]
[/ /docs /docs/guide /docs/guide/b]
0 [/new]
```

The path recorded for `/docs/guide/a` ends in `/b`. Both children appended to the same
three-element path, which had a free slot, so the second child overwrote the first, and
`out` kept a header that points at that slot. With a shallower tree the capacities happen to
line up differently and the bug disappears, which is what makes it hard to catch in tests.

`addPage` shows the other half: the function appended into the caller's spare capacity
(`pages[:1]` can see `"/new"` in the backing array), but the caller's header still has
length 0. The function's `pages` is a copy of the header, and assigning to it does not
reach the caller. Return the slice instead, the way `append` itself does:
`pages = addPage(pages, "/new")`.

The fix for `visit` is one line. Cap the capacity so each call gets its own array:

```go
path = append(path[:len(path):len(path)], page) // always a new array
```

```text
[/ /docs /docs/guide /docs/guide/a]
[/ /docs /docs/guide /docs/guide/b]
```

> [!WARNING]
> Storing or returning a slice obtained from `append` on a slice you do not own exclusively
> is the source of "values change by themselves" bugs. The symptom is a slice whose last
> elements change after an unrelated `append` elsewhere, often only for some input sizes.
> The fix is to make ownership explicit: `append(s[:len(s):len(s)], v)` when you append to
> a shared prefix, `slices.Clone(s)` when you keep a slice someone else will keep using,
> and `s = f(s)` (return the slice) when a function appends for its caller.

| Tool | Effect | Cost |
|---|---|---|
| `s = append(s, v)` | Always assign back; the result may or may not share with the old `s` | Amortised O(1) |
| `s[lo:hi:max]` | Limits capacity to `max - lo`; the next append copies | Free until the append |
| `slices.Clone(s)` | New array, same elements | O(n) copy now |
| `copy(dst, src)` | Copies into an existing array | O(n) |

> [!NOTE]
> A sub-slice keeps its whole backing array alive. `small := huge[:10]` on a slice of a
> 100 MB file keeps all 100 MB in memory as long as `small` lives. Clone the part you keep:
> `small := slices.Clone(huge[:10])`.

When linkcheck's crawler in [[step-2-crawl]] passes slices of links between functions,
these ownership rules decide who may append to what.
