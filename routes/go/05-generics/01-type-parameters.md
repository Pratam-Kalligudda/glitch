---
title: Type parameters
done_when: "You can write a generic function with a type parameter list, call it with and without explicit type arguments, and read the compiler error when a type argument is not allowed."
---
Before Go 1.18 a function that summed `[]int` and a function that summed `[]float64` were two
functions with the same body. The alternatives were worse: `interface{}` (now `any`) throws
away the type, so the compiler stops checking and you add type assertions. A **type
parameter** lets one function take a type as well as values: the compiler checks the body
once against a rule for the type, and checks each call against that rule.

A generic function declares its type parameters in square brackets after its name. Each one
has a name and a **constraint**, the set of types it may stand for. `any` means every type;
`int | float64` means those two. The next stop, [[constraints]], covers constraints fully.

```go title="main.go"
package main

import "fmt"

func SumInts(xs []int) int {
	total := 0
	for _, x := range xs {
		total += x
	}
	return total
}

func SumFloats(xs []float64) float64 {
	total := 0.0
	for _, x := range xs {
		total += x
	}
	return total
}

// Sum works for any slice whose element type is int or float64.
func Sum[T int | float64](xs []T) T {
	var total T
	for _, x := range xs {
		total += x
	}
	return total
}

func Map[T, U any](xs []T, f func(T) U) []U {
	out := make([]U, 0, len(xs))
	for _, x := range xs {
		out = append(out, f(x))
	}
	return out
}

func main() {
	fmt.Println(SumInts([]int{1, 2, 3}), SumFloats([]float64{1.5, 2.5}))
	fmt.Println(Sum([]int{1, 2, 3}), Sum([]float64{1.5, 2.5}))
	fmt.Println(Sum[float64]([]float64{1, 2}))

	lens := Map([]string{"go", "gopher", "generics"}, func(s string) int { return len(s) })
	fmt.Println(lens)

	fmt.Printf("%T %T\n", Sum[int], Map[string, bool])
	f := Sum[int]
	fmt.Println(f([]int{4, 5}))
}
```

```bash
go run .
```

```text
6 4
6 4
3
[2 6 8]
func([]int) int func([]string, func(string) bool) []bool
9
```

## How it works

`func Sum[T int | float64](xs []T) T` has two parameter lists. The first, in square
brackets, holds **type parameters**; the second, in parentheses, holds ordinary value
parameters. Inside the body, `T` is a type like any other: you declare `var total T`, use it
in `[]T`, and return it. The body may only do what every type in `T`'s constraint allows.
`+=` is fine because `int` and `float64` both support it.

At a call, you supply **type arguments** for the type parameters. There are two ways:

- **Explicit**: `Sum[float64](...)` gives the type argument in brackets. You may give a
  prefix of the list and let the compiler infer the rest.
- **Inferred**: `Sum([]int{1, 2, 3})` gives none. The compiler sees that the argument is a
  `[]int`, unifies that with `[]T`, and concludes `T` is `int`. [[inference]] covers the
  rules.

`Sum[int]` on its own, without a call, is a value: an ordinary function of type
`func([]int) int`, as the `%T` line shows. Instantiating a generic function with all its
type arguments yields a regular function you can store, pass, or call.

Generic code gets the same compile-time type safety as handwritten code: `Sum[int]` is
checked and behaves like `SumInts`.

## What the compiler rejects

Each call is checked against the constraint. Passing strings to `Sum`:

```go title="main.go"
package main

import "fmt"

func Sum[T int | float64](xs []T) T {
	var total T
	for _, x := range xs {
		total += x
	}
	return total
}

func main() {
	fmt.Println(Sum([]string{"a", "b"}))
}
```

```text
./main.go:14:17: string does not satisfy int | float64 (string missing in int | float64)
```

The check also runs on the body, once, for every possible `T`. A body may use only what the
constraint guarantees. With `any`, the compiler knows nothing about the type except that it
can be copied and assigned:

```go title="main.go"
package main

import "fmt"

func Zero[T any]() T {
	var z T
	return z
}

func Max[T any](a, b T) T {
	if a > b {
		return a
	}
	return b
}

func main() {
	fmt.Println(Zero())
}
```

```text
./main.go:11:5: invalid operation: a > b (type parameter T cannot use operator >)
./main.go:18:18: in call to Zero, cannot infer T (declared at ./main.go:5:11)
```

Two different errors. The first is a body error: `any` does not promise ordering, so `>`
is rejected for every call, even `Max(1, 2)`. Fix it by choosing a constraint that has the
operator ([[constraints]] shows `cmp.Ordered`). The second is a call error: `Zero` has no
parameter that mentions `T`, so there is nothing to infer from. Write `Zero[int]()`.

`Zero` shows the pattern for returning a zero value of any type: `var z T; return z`. There
is no `T{}` that works for every `T`, because a type parameter does not have a known
composite shape.

## Rules to remember

- A type parameter list needs at least one parameter; each has a constraint, and `any` is the
  loosest. `[T, U any]` shares one constraint between names.
- Type parameters belong to functions and types (see [[generic-types]]), and since Go 1.27 to
  methods too ([[generic-methods]]).
- A generic function used as a value needs its type arguments: given (`Sum[int]`), inferred
  from a call, or inferred from the type it is assigned to. `var g func([]int) int = Sum`
  compiles; `f := Sum` fails with `cannot use generic function Sum without instantiation`.

> [!WARNING]
> Writing a generic function when you only ever call it with one type is the most common
> mistake. Symptom: the signature has a type parameter list, and every call site passes the
> same type. Fix: write the plain function; add the type parameter when a second type
> actually appears. [[when-generics]] gives the full test.

> [!NOTE]
> The language specification section "Type parameter declarations" is the authority:
> <https://go.dev/ref/spec#Type_parameter_declarations>.

linkcheck's `Set[T]` in [[step-2-crawl]] is the kind of code type parameters exist for.
