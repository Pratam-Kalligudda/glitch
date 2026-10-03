---
title: Self-referential constraints
done_when: "You can write a constraint whose type parameter refers to itself, such as Adder[A Adder[A]], use it in a generic function, and explain what the error says when a method has the wrong shape."
---
(Go 1.26) Some operations take two values of the same type: `a.Add(b)`, `a.Less(b)`,
`a.Equal(b)`. A method like this mentions its own receiver type in its signature. To write
a generic function over such types, the constraint must say "a type `A` whose `Add` method
takes an `A` and returns an `A`". That is a constraint that refers to the type parameter it
constrains, and until Go 1.26 an interface could not refer to itself in its own type
parameter list. Go 1.26 lifts that restriction.

```go title="main.go"
package main

import "fmt"

// Adder is satisfied by a type A whose Add method takes and returns A.
// The constraint refers to the interface being declared: self-referential (Go 1.26).
type Adder[A Adder[A]] interface {
	Add(A) A
}

type Vec struct{ X, Y int }

func (v Vec) Add(o Vec) Vec { return Vec{v.X + o.X, v.Y + o.Y} }

type Money int

func (m Money) Add(o Money) Money { return m + o }

func Total[A Adder[A]](first A, rest ...A) A {
	sum := first
	for _, r := range rest {
		sum = sum.Add(r)
	}
	return sum
}

func main() {
	fmt.Println(Total(Vec{1, 2}, Vec{3, 4}, Vec{5, 6}))
	fmt.Println(Total(Money(5), Money(7)))
}
```

```bash
go run .
```

```text
{9 12}
12
```

## How it works

Read `type Adder[A Adder[A]] interface { Add(A) A }` from the inside. `Adder` has one type
parameter `A`. Its constraint, `Adder[A]`, is the interface itself instantiated with `A`: for
a type to be an `A`, it must have the methods of `Adder[A]`, that is `Add(A) A`. For
`Vec` this resolves to `Add(Vec) Vec`, which it has.

`Total[A Adder[A]]` uses the same constraint on the function. Inference finds `A = Vec` from
the arguments ([[inference]]). The body can then call `sum.Add(r)`, and the result is again
an `A`, so it can be assigned back to `sum`. Nothing converts through an interface: the
values stay `Vec` and `Money`, with no boxing or type assertion.

Without the self-reference you could write the constraint inline, and this form still works
in any Go version:

```go title="main.go"
package main

import "fmt"

func Total[A interface{ Add(A) A }](first A, rest ...A) A {
	for _, r := range rest {
		first = first.Add(r)
	}
	return first
}

type Money int

func (m Money) Add(o Money) Money { return m + o }

func main() { fmt.Println(Total(Money(1), Money(2))) }
```

```text
3
```

The difference is reuse. The inline form can appear on one function; the named
self-referential interface, `Adder[A]`, is one name for every function, type and other
constraint that needs it. It also makes your intent visible in documentation.

## What the compiler says when the shape is wrong

The method must have exactly the shape `Add(A) A`. A type whose `Add` takes a different
type does not satisfy it:

```go title="main.go"
package main

import "fmt"

type Adder[A Adder[A]] interface {
	Add(A) A
}

type Vec struct{ X, Y int }

func (v Vec) Add(o Vec) Vec { return Vec{v.X + o.X, v.Y + o.Y} }

type Bad struct{}

func (Bad) Add(o Vec) Vec { return o }

func Total[A Adder[A]](first A, rest ...A) A { return first }

func main() {
	fmt.Println(Total(Bad{}))
}
```

```text
./main.go:20:19: in call to Total, A (type Bad) does not satisfy Adder[A] (wrong type for method Add)
		have Add(Vec) Vec
		want Add(A) A
```

`have` is what `Bad` provides; `want` is the constraint with `A` standing for `Bad`. The
fix is to make the method take and return the receiver's own type.

On a toolchain older than Go 1.26 the declaration itself fails. Go 1.25.5 reports:

```text
./main.go:7:6: invalid recursive type: Adder refers to itself
./main.go:22:13: sum.Add undefined (type A has no field or method Add)
```

## Where it appears

The pattern fits "binary methods", whose second operand has the same type as the receiver:

| Constraint | Method | Typical use |
|---|---|---|
| `Adder[A Adder[A]]` | `Add(A) A` | summing vectors, money, durations |
| `Lesser[T Lesser[T]]` | `Less(T) bool` | ordering types that are not `cmp.Ordered` |
| `Equaler[T Equaler[T]]` | `Equal(T) bool` | equality that ignores some fields |
| `Cloner[T Cloner[T]]` | `Clone() T` | copying a value without knowing its type |

The last row shows the other use: a method that returns the receiver's type. Without the
self-reference a generic function could only get an interface back and would have to assert
it.

> [!WARNING]
> Using the pattern when `cmp.Ordered` or a function argument would do adds a method that
> every caller must implement. Symptom: a `Lesser` constraint on code that only sorts
> numbers and strings, so every caller has to wrap their types. Fix: use `cmp.Ordered` for
> ordered built-in types, and take `less func(a, b T) bool` or `cmp func(a, b T) int` when
> the ordering belongs to the caller, not the type, as `slices.SortFunc` does
> ([[compare-sort]]).

> [!NOTE]
> The release notes describe the change as lifting the restriction on generic types referring
> to themselves in their type parameter lists. The spec section "Type parameter declarations"
> has the formal rule: <https://go.dev/ref/spec#Type_parameter_declarations>.

linkcheck uses it once, in `Sorted[T Comparer[T]]` in [[step-7-reporters]]. [[when-generics]] puts it in context: it is for
library authors who need a binary method over their own types.
