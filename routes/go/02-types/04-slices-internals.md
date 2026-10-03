---
title: "Slices: length, capacity and the backing array"
---
A **slice** is not an array and does not hold elements itself. It is a small descriptor,
three words long, that points into an **array** somewhere in memory, the **backing
array**, and says how much of it you may see. Almost every surprising thing slices do
(writes that show up somewhere else, appends that sometimes do and sometimes do not affect
another slice, a "copy" that is not a copy) follows from that one fact. This stop takes the
descriptor apart; the next one, [[append-aliasing]], shows what it means for `append`.

## Looking inside a slice

```go title="main.go"
package main

import (
	"fmt"
	"unsafe"
)

func main() {
	arr := [6]int{0, 10, 20, 30, 40, 50}
	s := arr[1:4] // elements 1, 2, 3 of arr
	fmt.Println(s, len(s), cap(s))

	s[0] = 99 // writes into arr
	fmt.Println(arr)

	t := s[1:5] // reslice past len, up to cap
	fmt.Println(t, len(t), cap(t))

	fmt.Println(unsafe.Sizeof(s), unsafe.SliceData(s) == &arr[1])

	var grow []int
	last := -1
	for i := range 2000 {
		grow = append(grow, i)
		if cap(grow) != last {
			fmt.Printf("len=%-4d cap=%-4d\n", len(grow), cap(grow))
			last = cap(grow)
		}
	}
}
```

```bash
go run .
```

```text
[10 20 30] 3 5
[0 99 20 30 40 50]
[20 30 40 50] 4 4
24 true
len=1    cap=4   
len=5    cap=8   
len=9    cap=16  
len=17   cap=32  
len=33   cap=64  
len=65   cap=128 
len=129  cap=256 
len=257  cap=512 
len=513  cap=848 
len=849  cap=1280
len=1281 cap=1792
len=1793 cap=2560
```

## How it works: the slice header

A slice value is a **header** of three fields:

| Field | Meaning | Read with |
|---|---|---|
| pointer | Address of the slice's first element inside the backing array | `unsafe.SliceData(s)` (rarely needed) |
| length | How many elements you can index: `s[0]` to `s[len-1]` | `len(s)` |
| capacity | How many elements exist from the pointer to the end of the backing array | `cap(s)` |

On a 64-bit machine that is 3 × 8 = 24 bytes, which is what `unsafe.Sizeof(s)` printed,
however many elements the slice has. The elements live in the backing array.

`arr[1:4]` builds a header with the pointer at `&arr[1]` (the last line of output confirms
it), length `4 - 1 = 3`, and capacity `6 - 1 = 5`, everything from index 1 to the end of
the array. Nothing is copied. So:

- **Writing through a slice writes the array.** `s[0] = 99` changed `arr[1]`.
- **Slicing can reach past the length, up to the capacity.** `s[1:5]` is legal although
  `len(s)` is 3: the elements 40 and 50 are still there in the backing array. Going past
  the capacity panics: `s[1:6]` gives
  `panic: runtime error: slice bounds out of range [:6] with capacity 5`.
- **Indexing is checked against the length.** `src[5]` on a length-4 slice panics with
  `index out of range [5] with length 4`. Go never lets you read past a slice, which is why
  a slice can safely be handed around without its array.

The general form is `s[low:high]`: length `high - low`, capacity `cap(s) - low`. Missing
`low` means 0, missing `high` means `len(s)`.

## How it works: growth

`append(s, v)` writes `v` at index `len(s)` if `len(s) < cap(s)`, and returns a header with
the length one larger. When the backing array is full, `append` allocates a **new, larger
array**, copies the elements across, writes `v`, and returns a header pointing at the new
array. The old array is left as it was.

How much larger is a runtime decision. In Go 1.27, `runtime.nextslicecap` doubles the
capacity while it is below 256 elements, then grows by about 1.25× plus a constant
(`newcap += (newcap + 768) / 4`), so large slices do not waste half their memory. The
result is then rounded up to the memory allocator's size classes, which is why you see
848 and 1280 instead of tidy numbers, and why the first `append` here gave capacity 4,
not 1: the compiler can now place a small backing array on the stack (Go 1.25 and 1.26
extended this). Run the same loop on a slice that escapes to the heap and the first
capacities differ. The exact numbers are not part of the language; never write code that
depends on them.

Growth is amortised: doubling means each element is copied a constant number of times on
average, so appending n elements is O(n) overall. It is still work you can avoid when you
know the size.

## Creating slices

```go title="mk/main.go"
package main

import "fmt"

func hosts(urls []string) []string {
	out := make([]string, len(urls)) // length 3: three empty strings already
	for _, u := range urls {
		out = append(out, u)
	}
	return out
}

func main() {
	got := hosts([]string{"a.example", "b.example", "c.example"})
	fmt.Printf("%d %q\n", len(got), got)

	var nilSlice []int
	empty := []int{}
	made := make([]int, 0, 10)
	fmt.Println(nilSlice == nil, empty == nil, made == nil)
	fmt.Println(len(nilSlice), len(empty), len(made), cap(made))

	src := []int{1, 2, 3, 4}
	dst := make([]int, 2)
	n := copy(dst, src)
	fmt.Println(n, dst)

	fmt.Println(src[1:3][0], src[:0], src[4:])
	i := 5
	fmt.Println(src[i])
}
```

The panic trace is shortened to the file name:

```text
6 ["" "" "" "a.example" "b.example" "c.example"]
true false false
0 0 0 10
2 [1 2]
2 [] []
panic: runtime error: index out of range [5] with length 4

goroutine 1 [running]:
main.main()
	.../mk/main.go:30 +0x496
exit status 2
```

| Expression | Length | Capacity | Notes |
|---|---|---|---|
| `var s []int` | 0 | 0 | `nil` slice. Works with `len`, `range`, `append` |
| `[]int{}` | 0 | 0 | Empty but not `nil` |
| `[]int{1, 2, 3}` | 3 | 3 | Literal; allocates a backing array |
| `make([]int, n)` | n | n | n zero values, ready to index |
| `make([]int, 0, n)` | 0 | n | Room for n appends without reallocating |
| `arr[lo:hi]`, `s[lo:hi]` | hi − lo | cap − lo | Shares the backing array |

`copy(dst, src)` copies `min(len(dst), len(src))` elements and returns that count; it is
the one built-in that moves elements between backing arrays. A `nil` and an empty slice
behave the same for everything except `== nil`, reflection and encoders: `encoding/json`
writes `null` for one and `[]` for the other (see [[json]]). Prefer `len(s) == 0` to test
for "no elements".

> [!WARNING]
> `make([]T, n)` followed by `append` is the most common slice bug. `make` with a length
> creates n zero values, and `append` adds after them. The symptom is a result twice as
> long as expected with zero values (`""`, `0`, `nil`) at the front, as in the first output
> line above. Either index into the made slice (`out[i] = u`) or make it with length 0 and
> a capacity: `out := make([]string, 0, len(urls))`.

> [!NOTE]
> Arrays (`[6]int`) are values: the length is part of the type and assigning an array copies
> all its elements. Slices are the flexible view you normally pass around; arrays mostly
> appear as backing storage, fixed-size keys (`[32]byte` for a SHA-256 sum) and buffers.

Preallocating with `make([]T, 0, n)` is one of the cheapest optimisations you will measure
in [[pools-builders]].
