---
title: The slices and maps packages
done_when: "You can sort, search, edit and compare slices and maps with the slices and maps packages, convert between iterators and collections, and avoid the aliasing and sorted-input mistakes."
---
The `slices` and `maps` packages (Go 1.21, extended in 1.23 with iterator functions) hold
the generic helpers that Go code used to write by hand: sort a slice, find an element,
delete a range, copy a map. They are the first big use of the generics from
[[type-parameters]] and the iterators from [[range-func]]. Their signatures use the
`S ~[]E` pattern from [[inference]], so they accept your own named slice types and return
the same type.

```go title="main.go"
package main

import (
	"cmp"
	"fmt"
	"maps"
	"slices"
	"strings"
)

type User struct {
	Name string
	Age  int
}

func main() {
	nums := []int{5, 2, 8, 2, 9, 1}

	// Search and compare
	fmt.Println(slices.Contains(nums, 8), slices.Index(nums, 2), slices.Max(nums), slices.Min(nums))

	// Sorting: Sort for ordered types, SortFunc with cmp.Compare for the rest
	sorted := slices.Clone(nums)
	slices.Sort(sorted)
	fmt.Println(sorted, slices.IsSorted(sorted))
	i, found := slices.BinarySearch(sorted, 8)
	fmt.Println("binary search", i, found)

	users := []User{{"Cy", 30}, {"Al", 25}, {"Bo", 30}}
	slices.SortFunc(users, func(a, b User) int {
		return cmp.Or(
			-cmp.Compare(a.Age, b.Age), // oldest first
			strings.Compare(a.Name, b.Name),
		)
	})
	fmt.Println(users)

	// Editing
	sorted = slices.Compact(sorted) // removes consecutive duplicates
	fmt.Println(sorted)
	sorted = slices.Insert(sorted, 1, 100, 200)
	fmt.Println(sorted)
	sorted = slices.Delete(sorted, 1, 3)
	fmt.Println(sorted)
	slices.Reverse(sorted)
	fmt.Println(sorted)

	// Iterators <-> slices
	for i, v := range slices.All([]string{"a", "b"}) {
		fmt.Print(i, v, " ")
	}
	for i, v := range slices.Backward([]string{"a", "b"}) {
		fmt.Print(i, v, " ")
	}
	fmt.Println()
	for c := range slices.Chunk([]int{1, 2, 3, 4, 5}, 2) {
		fmt.Print(c, " ")
	}
	fmt.Println()

	// Maps
	ages := map[string]int{"cy": 30, "al": 25, "bo": 30}
	keys := slices.Sorted(maps.Keys(ages)) // iterator -> sorted slice
	fmt.Println(keys)
	vals := slices.Sorted(maps.Values(ages))
	fmt.Println(vals)

	clone := maps.Clone(ages)
	maps.DeleteFunc(clone, func(k string, v int) bool { return v < 30 })
	fmt.Println(len(clone), len(ages), maps.Equal(clone, ages))

	byIndex := maps.Collect(slices.All([]string{"zero", "one", "two"}))
	fmt.Println(byIndex)

	evens := slices.Collect(func(yield func(int) bool) {
		for i := 0; i < 10; i += 2 {
			if !yield(i) {
				return
			}
		}
	})
	fmt.Println(evens, slices.Concat(evens, []int{99}), slices.Repeat([]int{1, 2}, 2))
}
```

```bash
go run .
```

```text
true 1 9 1
[1 2 2 5 8 9] true
binary search 4 true
[{Bo 30} {Cy 30} {Al 25}]
[1 2 5 8 9]
[1 100 200 2 5 8 9]
[1 2 5 8 9]
[9 8 5 2 1]
0a 1b 1b 0a 
[1 2] [3 4] [5] 
[al bo cy]
[25 30 30]
2 3 false
map[0:zero 1:one 2:two]
[0 2 4 6 8] [0 2 4 6 8 99] [1 2 1 2]
```

## The functions

**`slices`**

| Group | Functions | Notes |
|---|---|---|
| Search | `Contains`, `Index`, `ContainsFunc`, `IndexFunc` | `Index` returns `-1` when absent |
| Compare | `Equal`, `Compare`, `EqualFunc`, `CompareFunc` | element by element |
| Order | `Sort`, `SortFunc`, `SortStableFunc`, `IsSorted`, `IsSortedFunc` | in place |
| Binary search | `BinarySearch`, `BinarySearchFunc` | slice must already be sorted |
| Extremes | `Min`, `Max`, `MinFunc`, `MaxFunc` | panic on an empty slice |
| Edit | `Insert`, `Delete`, `DeleteFunc`, `Replace`, `Compact`, `CompactFunc`, `Reverse` | change the slice; use the result |
| Copy and size | `Clone`, `Concat`, `Repeat`, `Grow`, `Clip` | |
| From iterators | `Collect`, `AppendSeq`, `Sorted`, `SortedFunc`, `SortedStableFunc` | build slices from `iter.Seq` |
| To iterators | `All`, `Values`, `Backward`, `Chunk` | `All` yields index and value; `Values` only values |

**`maps`**

| Function | Does |
|---|---|
| `Keys(m)`, `Values(m)`, `All(m)` | iterators over keys, values, pairs; order is random |
| `Collect(seq2)` | build a map from an `iter.Seq2` |
| `Insert(m, seq2)` | add the pairs of a sequence to an existing map |
| `Clone(m)`, `Copy(dst, src)` | copy a map (shallow) |
| `Equal(m1, m2)`, `EqualFunc` | same keys with equal values |
| `DeleteFunc(m, del)` | delete entries the function selects |

## How it works

**In-place functions mutate the slice you pass; functions that remove or add elements return
a new slice header, and you must use it.** `slices.Sort` sorts in place and returns
nothing. `slices.Insert`, `Delete` and `Compact` return the slice with its new length, as
`append` does ([[append-aliasing]]): write `s = slices.Delete(s, i, j)`. The old variable
may be left with surprising contents.

**Order functions take a three-way comparison returning an `int`.** `SortFunc` expects
`func(a, b T) int`: negative if `a` sorts first, zero if equal, positive otherwise. Build
it with `cmp.Compare` (any ordered type) and `strings.Compare`, and chain keys with
`cmp.Or`, which returns the first non-zero value, as above: oldest first, then by name
([[compare-sort]]). `SortFunc` is not stable; use `SortStableFunc` when equal elements must
keep their order.

**Iterators connect the two packages.** `maps.Keys(m)` returns an `iter.Seq`, not a slice.
Wrap it in `slices.Sorted` to get the sorted keys: the idiom for a stable, readable iteration
over a map ([[range-forms]]). `slices.Collect` gathers any `iter.Seq` into a new slice, and
`maps.Collect` any `iter.Seq2` into a new map: `maps.Collect(slices.All(s))` builds an
index-to-value map. Your own iterators from [[writing-iterators]] plug into the same
functions.

**Maps functions are shallow.** `maps.Clone` copies keys and values; a value that is a slice
or pointer still points to the same data ([[copying]]).

## What goes wrong

```go title="main.go"
package main

import (
	"fmt"
	"slices"
)

func main() {
	// Delete and Insert reuse the backing array: the old slice is not safe.
	orig := []int{1, 2, 3, 4, 5}
	got := slices.Delete(orig, 1, 3)
	fmt.Println(got, orig) // orig's tail is zeroed (Go 1.22)

	// Compact removes only consecutive duplicates.
	fmt.Println(slices.Compact([]int{1, 2, 1, 1, 2}))

	// BinarySearch on an unsorted slice gives a wrong answer, silently.
	i, ok := slices.BinarySearch([]int{3, 1, 2}, 1)
	fmt.Println(i, ok)

	// Max on an empty slice panics.
	defer func() { fmt.Println("recovered:", recover()) }()
	fmt.Println(slices.Max([]int{}))
}
```

```text
[1 4 5] [1 4 5 0 0]
[1 2 1 2]
0 false
recovered: slices.Max: empty list
```

- `Delete` shifted the elements left inside the same array and zeroed the freed tail, so
  `orig` now reads `[1 4 5 0 0]`. Do not keep using the old slice; use the one returned.
- `Compact` removes runs of equal neighbours, so on `[1 2 1 1 2]` it only merged the middle
  pair. Sort first if you want all duplicates removed.
- `BinarySearch` assumes sorted input. On `[3 1 2]` it said `1` was not found, though it is
  there, and gave no error.
- `Min` and `Max` panic with `slices.Max: empty list`. Check `len(s) > 0` first.

> [!WARNING]
> Using `slices.Delete`, `Insert` or `Compact` without assigning the result. Symptom:
> `slices.Delete(s, 0, 1)` on its own line leaves `len(s)` unchanged, but the contents have
> shifted and the tail is zeroed, so the slice now has the wrong data. Fix:
> `s = slices.Delete(s, 0, 1)`.

> [!NOTE]
> The packages are small; read their documentation once: <https://pkg.go.dev/slices> and
> <https://pkg.go.dev/maps>. `sort.Slice` and `sort.Ints` still work, but `slices.Sort` and
> `slices.SortFunc` are type-safe, so prefer them in new code.

linkcheck sorts its results with `slices.SortFunc` and exposes them as an `iter.Seq` in
[[step-7-reporters]].
