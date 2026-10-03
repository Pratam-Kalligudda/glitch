---
title: Type inference
done_when: "You can predict which type arguments the compiler infers for a call, say when it cannot, and supply explicit type arguments in the right order."
---
You rarely write type arguments. In `Max(3, 7)` nobody wrote `Max[int]`; the compiler worked
out `T = int` from the arguments. That process is **type inference**. Knowing its rules tells
you how to design signatures that infer well, and what the error "cannot infer T" means.

```go title="main.go"
package main

import (
	"cmp"
	"fmt"
	"strconv"
)

func Max[T cmp.Ordered](a, b T) T {
	if a > b {
		return a
	}
	return b
}

func Map[T, U any](xs []T, f func(T) U) []U {
	out := make([]U, 0, len(xs))
	for _, x := range xs {
		out = append(out, f(x))
	}
	return out
}

// S ~[]E: S is any slice type, E is its element type. Both are inferred.
func Reverse[S ~[]E, E any](s S) S {
	out := make(S, len(s))
	for i, v := range s {
		out[len(s)-1-i] = v
	}
	return out
}

type IDs []int

func Double[T ~int | ~float64](x T) T { return x * 2 }

func main() {
	// 1. from typed arguments
	fmt.Println(Max(3, 7))
	// 2. untyped constants of different kinds
	fmt.Printf("%T %v\n", Max(1, 2.5), Max(1, 2.5))
	// 3. a typed argument decides for the untyped one
	var f float32 = 1.5
	fmt.Printf("%T\n", Max(f, 2))
	// 4. function arguments, including generic functions
	strs := Map([]int{1, 2, 3}, strconv.Itoa)
	fmt.Printf("%q\n", strs)
	fmt.Println(Map([]int{1, 2}, Double[int]))
	fmt.Println(Map([]int{1, 2}, Double)) // Double's T inferred from Map's T
	// 5. core types: the named type is kept
	r := Reverse(IDs{1, 2, 3})
	fmt.Printf("%T %v\n", r, r)
	// 6. assignment context (Go 1.27)
	var g func(int, int) int = Max
	fmt.Println(g(4, 2))
}
```

```bash
go run .
```

```text
7
float64 2.5
float32
["1" "2" "3"]
[2 4]
[2 4]
main.IDs [3 2 1]
4
```

## How it works

Inference is **unification**: the compiler matches the type of each argument against the
type of the matching parameter, and every type parameter that shows up on one side is bound
to what is on the other. It runs on the call's arguments, in these steps:

1. **Typed arguments first.** `Max(3, 7)` has untyped constants only, so this step binds
   nothing yet. `Max(f, 2)` binds `T = float32` from `f`. For `Map([]int{...}, ...)`,
   matching `[]int` against `[]T` binds `T = int`.
2. **Function arguments.** `strconv.Itoa` has type `func(int) string`; matching it against
   `func(T) U` confirms `T = int` and binds `U = string`. `Double` is itself generic, so
   its own `T` is inferred too, from the `T` Map already knows (Go 1.21 added this). The
   parameter and result types of a function argument are how `U` gets inferred without any
   explicit mention.
3. **Core types.** `Reverse[S ~[]E, E any]` has two parameters, but you pass one argument.
   `S` binds to `IDs`. Its constraint `~[]E` says the underlying type is `[]E`, so the
   compiler infers `E = int` from that. This is why generic slice functions in the standard
   library are declared `func Sort[S ~[]E, E cmp.Ordered](x S)`: returning `S` keeps the
   caller's named type, as `main.IDs` shows, where `func Reverse[E any](s []E) []E` would
   hand back a plain `[]int`.
4. **Untyped constants last.** Constants with no type take their default type (`int`,
   `float64`, `string`, ...) only when nothing typed decided the type parameter. If several
   untyped constants of different kinds feed one type parameter, the larger kind wins, as
   with operators: `Max(1, 2.5)` is `float64` (Go 1.21 allows this; earlier versions
   reported an error).
5. **Assignment context (Go 1.27).** A generic function assigned to a typed variable, or
   converted to a function type, is inferred from that type: `var g func(int, int) int = Max`.

The return type of a call is never used for inference. `var n int = Zero()` does not infer
`T = int`.

## When inference fails

```go title="main.go"
package main

import "fmt"

func Zero[T any]() T {
	var z T
	return z
}

func Max[T int | float64](a, b T) T {
	if a > b {
		return a
	}
	return b
}

func main() {
	var n int = Zero()
	fmt.Println(n)

	var x int = 1
	var y float64 = 2
	fmt.Println(Max(x, y))
}
```

```text
./main.go:18:18: in call to Zero, cannot infer T (declared at ./main.go:5:11)
./main.go:23:21: in call to Max, type float64 of y does not match inferred type int for T
```

Two failures, two causes. `Zero` has no argument that mentions `T`, and the result type does
not count: write `Zero[int]()`. `Max(x, y)` is a conflict: two typed arguments bind `T` to
different types, and there is no conversion. Fix it by converting one argument:
`Max(x, int(y))`, or `Max[float64](float64(x), y)`.

## Explicit type arguments

Type arguments bind to parameters in declaration order, and you may give a prefix. The
rest are inferred:

```go title="main.go"
package main

import "fmt"

func Convert[To, From ~int | ~float64](x From) To { return To(x) }

func main() {
	fmt.Println(Convert[float64](3))
	fmt.Printf("%T\n", Convert[float64, int](3))
}
```

```text
3
float64
```

`To` cannot be inferred (it appears only in the result), `From` can. So the parameter that
callers must name goes first in the list, and the ones inferred from arguments go last.
That order is a design decision: when you write a generic function, put the type parameters
callers must spell out first.

> [!WARNING]
> Declaring a type parameter that appears only in the result, or in no parameter, forces
> every caller to write brackets. Symptom: `cannot infer T` at every call site. Fix: make
> the type appear in a parameter (pass a value or a function), or order the
> parameters so that the ones callers must supply come first and document it.

> [!NOTE]
> Inference is conservative on purpose. When it does not do what you expect, writing the
> type argument is always allowed and always clear. The exact algorithm is in the spec
> section "Type inference": <https://go.dev/ref/spec#Type_inference>.

linkcheck writes `Set[string]` with an explicit type argument in [[step-2-crawl]] and calls
its `Sorted` and `Filter` helpers with inferred ones in [[step-7-reporters]]. The
standard library's slice functions rely on the `S ~[]E` pattern; see [[slices-maps-pkgs]].
