---
title: Comparing and sorting
done_when: "You can sort a slice of structs by several keys with slices.SortFunc and cmp.Or, and you never write a comparison as a - b."
---
Sorting needs two questions answered about a type: are two values **equal**, and which
one comes **first**. Go answers the first with `==`, which works only on *comparable*
types, and the second with `<` on *ordered* types (numbers and strings). Everything else,
such as a struct of results, is sorted with a **comparison function** you write: it takes
two values and returns a negative number, zero or a positive number. This stop covers the
rules for both and the standard way to sort in Go 1.27.

## Equality and ordering

```go title="main.go"
package main

import (
	"cmp"
	"fmt"
	"math"
)

type Point struct{ X, Y int }

type Edge struct {
	From, To string
}

func main() {
	// Structs compare field by field; arrays element by element.
	fmt.Println("Point{1,2} == Point{1,2}:", Point{1, 2} == Point{1, 2})
	fmt.Println("[2]int{1,2} == [2]int{1,3}:", [2]int{1, 2} == [2]int{1, 3})

	// Any comparable type can be a map key, including structs and arrays.
	seen := map[Edge]bool{}
	seen[Edge{"/", "/docs"}] = true
	fmt.Println("edge seen:", seen[Edge{From: "/", To: "/docs"}])

	// Pointers compare by address, not by what they point to.
	p, q := &Point{1, 2}, &Point{1, 2}
	fmt.Println("p == q:", p == q, " *p == *q:", *p == *q)

	// Three-way comparison: -1, 0 or +1.
	fmt.Println("cmp.Compare(2, 5):", cmp.Compare(2, 5))
	fmt.Println(`cmp.Compare("b", "a"):`, cmp.Compare("b", "a"))
	fmt.Println("cmp.Less(2, 5):", cmp.Less(2, 5))

	// NaN breaks the ordering operators; cmp treats it consistently.
	nan := math.NaN()
	fmt.Println("nan == nan:", nan == nan, " nan < 1:", nan < 1, " 1 < nan:", 1 < nan)
	fmt.Println("cmp.Compare(nan, nan):", cmp.Compare(nan, nan), " cmp.Compare(nan, 1):", cmp.Compare(nan, 1.0))
}
```

```bash
go run .
```

```text
Point{1,2} == Point{1,2}: true
[2]int{1,2} == [2]int{1,3}: false
edge seen: true
p == q: false  *p == *q: true
cmp.Compare(2, 5): -1
cmp.Compare("b", "a"): 1
cmp.Less(2, 5): true
nan == nan: false  nan < 1: false  1 < nan: false
cmp.Compare(nan, nan): 0  cmp.Compare(nan, 1): -1
```

### How it works

**Comparable types** support `==` and `!=` and can be map keys: booleans, numbers,
strings, pointers, channels, interfaces, and structs and arrays whose fields or elements
are all comparable. Struct equality compares every field in order; array equality every
element. Pointers are equal when they point to the same variable, which is why `p == q` is
false although `*p == *q` is true.

**Not comparable:** slices, maps and functions (except against `nil`), and any struct or
array that contains one. The compiler rejects both the comparison and the map key:

```go title="main.go"
package main

import "fmt"

type Page struct {
	URL   string
	Links []string
}

func main() {
	a := Page{URL: "/"}
	b := Page{URL: "/"}
	fmt.Println(a == b)
	seen := map[Page]bool{}
	fmt.Println(seen)
}
```

```text
./main.go:13:14: invalid operation: a == b (struct containing []string cannot be compared)
./main.go:14:14: invalid map key type Page
```

Interfaces are the exception that slips through: they are comparable at compile time but
panic at run time if both hold the same uncomparable type, as shown in
[[interface-values]].

**Ordered types** support `<`, `<=`, `>`, `>=`: integers, floats and strings (compared
byte by byte). The `cmp` package wraps them: `cmp.Compare(a, b)` returns -1, 0 or +1, and
`cmp.Less` returns a bool. They exist mostly for floats. `NaN` is unequal to everything,
itself included, and every `<` with it is false, so a sort using `<` on data with `NaN`
has no consistent order. `cmp.Compare` defines `NaN` as equal to `NaN` and less than any
other number, which gives a consistent order.

## Sorting

The `slices` package (Go 1.21) is the modern way to sort; [[slices-maps-pkgs]] covers the
rest of it. Its functions are generic, but you call them like any function.

```go title="main.go"
package main

import (
	"cmp"
	"fmt"
	"slices"
	"sort"
	"strings"
)

type Result struct {
	URL    string
	Status int
	Bytes  int64
}

// byURL implements sort.Interface, the pre-generics way to sort.
type byURL []Result

func (s byURL) Len() int           { return len(s) }
func (s byURL) Less(i, j int) bool { return s[i].URL < s[j].URL }
func (s byURL) Swap(i, j int)      { s[i], s[j] = s[j], s[i] }

func show(label string, rs []Result) {
	fmt.Println(label)
	for _, r := range rs {
		fmt.Printf("  %d %-22s %d\n", r.Status, r.URL, r.Bytes)
	}
}

func main() {
	results := []Result{
		{"https://go.dev/doc", 200, 5120},
		{"https://go.dev/nope", 404, 90},
		{"https://go.dev/", 200, 20480},
		{"https://go.dev/old", 404, 120},
		{"https://go.dev/blog", 200, 5120},
	}

	// Ordered types: slices.Sort uses <.
	codes := []int{404, 200, 500, 200}
	slices.Sort(codes)
	fmt.Println("codes:", codes)

	// One key, with a comparison function.
	slices.SortFunc(results, func(a, b Result) int {
		return strings.Compare(a.URL, b.URL)
	})
	show("by URL:", results)

	// Several keys: cmp.Or returns the first non-zero comparison.
	slices.SortFunc(results, func(a, b Result) int {
		return cmp.Or(
			cmp.Compare(b.Status, a.Status), // status descending: arguments swapped
			cmp.Compare(a.Bytes, b.Bytes),   // then size ascending
			strings.Compare(a.URL, b.URL),   // then URL, so the order is total
		)
	})
	show("by status desc, bytes, URL:", results)

	// Binary search needs the same order the slice was sorted with.
	slices.SortFunc(results, func(a, b Result) int { return strings.Compare(a.URL, b.URL) })
	i, found := slices.BinarySearchFunc(results, "https://go.dev/nope", func(r Result, url string) int {
		return strings.Compare(r.URL, url)
	})
	fmt.Println("binary search for /nope: index", i, "found", found)

	// The older sort package still works and you will see it in existing code.
	sort.Sort(sort.Reverse(byURL(results)))
	show("sort.Sort, reversed:", results)
}
```

```bash
go run .
```

```text
codes: [200 200 404 500]
by URL:
  200 https://go.dev/        20480
  200 https://go.dev/blog    5120
  200 https://go.dev/doc     5120
  404 https://go.dev/nope    90
  404 https://go.dev/old     120
by status desc, bytes, URL:
  404 https://go.dev/nope    90
  404 https://go.dev/old     120
  200 https://go.dev/blog    5120
  200 https://go.dev/doc     5120
  200 https://go.dev/        20480
binary search for /nope: index 3 found true
sort.Sort, reversed:
  404 https://go.dev/old     120
  404 https://go.dev/nope    90
  200 https://go.dev/doc     5120
  200 https://go.dev/blog    5120
  200 https://go.dev/        20480
```

### How it works

- A comparison function returns negative when `a` sorts before `b`, positive when after,
  and zero when they are equal for sorting purposes. To reverse a key, swap the arguments,
  as the status key does.
- `cmp.Or` returns its first argument that is not the zero value. With comparisons that
  means "the first key that differs decides", which is exactly a multi-key sort. All three
  comparisons are computed, which is cheap for these keys.
- `slices.SortFunc` is **not stable**: elements that compare equal may end up in any
  order. The last key (URL) makes the order total, so the output never depends on the
  input order. When you want equal elements to keep their input order instead, use
  `slices.SortStableFunc`.
- The function must be a **strict weak ordering**: consistent (if `a` is before `b` and
  `b` before `c`, then `a` is before `c`) and never claiming both "a before b" and "b
  before a". If it breaks those rules, the sort does not fail; it returns a wrong order.
- `slices.BinarySearchFunc` finds an element in O(log n), but only in a slice sorted by
  the same ordering. It returns the index where the target is or would be inserted, and
  whether it was found.
- `sort.Interface` (`Len`, `Less`, `Swap`) is the older, interface-based API. It is how
  sorting worked before generics and you will meet it in existing code; `sort.Reverse`
  wraps one to flip `Less`. New code uses `slices`.

| Function | Use |
|---|---|
| `slices.Sort(s)` | Ordered element types; NaNs first |
| `slices.SortFunc(s, cmp)` | Any element type, not stable |
| `slices.SortStableFunc(s, cmp)` | Keeps equal elements in input order |
| `slices.IsSortedFunc(s, cmp)` | Checks an order, useful in tests |
| `slices.BinarySearchFunc(s, target, cmp)` | Search a slice sorted with the same order |
| `cmp.Compare(a, b)` / `strings.Compare(a, b)` | Three-way comparison of ordered values / strings |
| `cmp.Or(c1, c2, ...)` | First non-zero value: chain sort keys |
| `sort.Sort(data)` / `sort.Slice(s, less)` | Older APIs, still supported |

## The subtraction trap

Returning `a - b` looks like a neat comparison function for integers. It overflows:

```go title="main.go"
package main

import (
	"cmp"
	"fmt"
	"math"
	"slices"
)

func main() {
	// Offsets in bytes, relative to some position: they can be negative.
	offsets := []int{3, math.MaxInt, -2, 0, math.MinInt + 1}

	bad := slices.Clone(offsets)
	slices.SortFunc(bad, func(a, b int) int { return a - b }) // overflows
	fmt.Println("a - b:      ", bad)

	good := slices.Clone(offsets)
	slices.SortFunc(good, func(a, b int) int { return cmp.Compare(a, b) })
	fmt.Println("cmp.Compare:", good)

	big, neg := math.MaxInt, -2
	fmt.Println("MaxInt - (-2) =", big-neg)
}
```

```text
a - b:       [3 9223372036854775807 -9223372036854775807 -2 0]
cmp.Compare: [-9223372036854775807 -2 0 3 9223372036854775807]
MaxInt - (-2) = -9223372036854775807
```

Integer arithmetic in Go wraps around silently. `MaxInt - (-2)` wraps to a large negative
number, so the function claims `MaxInt` sorts before `-2`. The ordering is no longer
consistent and the "sorted" result is nonsense, with no error.

> [!WARNING]
> Never compute a comparison with subtraction. Symptom: sorts that are correct on small
> test data and wrong for large or negative values (timestamps, file offsets, IDs). Fix:
> use `cmp.Compare(a, b)`, which only compares and cannot overflow. The same goes for
> floats with `NaN`: use `cmp.Compare` instead of hand-written `<` logic.

> [!NOTE]
> Use `strings.Compare` or `cmp.Compare` for string keys in comparison functions. For a
> plain `if a < b`, the operators are clearer and faster, as the `strings.Compare`
> documentation itself says.

linkcheck sorts its results by URL with a `Compare` method and `slices.SortedFunc` before
reporting them in [[step-7-reporters]].
