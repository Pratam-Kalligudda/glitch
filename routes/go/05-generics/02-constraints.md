---
title: Constraints
done_when: "You can write a constraint interface with a union and ~ terms, explain why cmp.Ordered and comparable exist, and fix a 'does not satisfy' error."
---
A **constraint** says which types a type parameter accepts and, by the same rule, which
operations the function body may use. In Go a constraint is an interface. An interface you
know lists **methods** a type must have. A constraint interface can also list **types**, and
the set of types that satisfy it is its **type set**.

A body may do anything that is valid for every type in the type set: `+` is allowed if all
the types support it, `>` if all are ordered, `.Len()` if the constraint lists that method.

```go title="main.go"
package main

import (
	"cmp"
	"fmt"
	"strings"
)

// Number is a constraint: the type set is int, int64, float64 and every type
// whose underlying type is one of them.
type Number interface {
	~int | ~int64 | ~float64
}

type Celsius float64

func Sum[T Number](xs []T) T {
	var total T
	for _, x := range xs {
		total += x
	}
	return total
}

func Max[T cmp.Ordered](a, b T) T {
	if a > b {
		return a
	}
	return b
}

// Index needs ==, which comparable provides.
func Index[T comparable](xs []T, want T) int {
	for i, x := range xs {
		if x == want {
			return i
		}
	}
	return -1
}

// Stringish lists a type term and a method: both must hold.
type Stringish interface {
	~string
	Len() int
}

type Name string

func (n Name) Len() int { return len(n) }

func Shout[T Stringish](s T) string {
	return strings.ToUpper(string(s)) + fmt.Sprint(" ", s.Len())
}

func main() {
	fmt.Println(Sum([]Celsius{20.5, 1.5}))
	fmt.Println(Max("apple", "pear"), Max(3, 2), Max(1.5, 2.5))
	fmt.Println(Index([]string{"a", "b"}, "b"), Index([]int{1, 2}, 9))
	fmt.Println(Shout(Name("go")))
	fmt.Printf("%T\n", Sum([]Celsius{1}))
}
```

```bash
go run .
```

```text
22
pear 3 2.5
1 -1
GO 2
main.Celsius
```

## How it works

**A union lists types.** `int | float64` is a type set of exactly those two. A constraint
may be written inline (`[T int | float64]`) or as a named interface, as `Number` is. More
than one line of terms in an interface is an intersection: a type must satisfy all of them,
as `Stringish` shows with a type term and a method.

**`~T` means "any type whose underlying type is `T`".** Without the tilde, `int` means
exactly `int`. `Celsius` is a defined type ([[defined-types]]) whose underlying type is
`float64`, so it is in `~float64` but not in `float64`. Almost always you want the tilde:
callers define their own types over `int` and `string` constantly. The result `Sum`
returns is a `Celsius`, not a `float64`, because `T` is `Celsius`; the last `%T` line
confirms it.

**`comparable` is the constraint for `==` and `!=`.** It is a predeclared interface. Slices,
maps and functions are not comparable, so they are rejected at compile time.

**`cmp.Ordered` is the constraint for `<`, `<=`, `>`, `>=`.** It lives in the `cmp` package
and is every integer type, every float type and `string` (each with `~`). Types such as
structs are not ordered, so `cmp.Ordered` rejects them; for those you pass a comparison
function ([[compare-sort]] shows `cmp.Compare` and `slices.SortFunc`).

**`any` is an alias for `interface{}`.** As a constraint it is the set of all types, so the
body can do almost nothing with a value except store, pass and return it.

## What the compiler rejects

Without the tilde, a caller's own type is not in the type set:

```go title="main.go"
package main

import "fmt"

type Number interface {
	int | float64
}

type Celsius float64

func Sum[T Number](xs []T) T {
	var total T
	for _, x := range xs {
		total += x
	}
	return total
}

func main() {
	fmt.Println(Sum([]Celsius{20.5, 1.5}))
}
```

```text
./main.go:20:17: Celsius does not satisfy Number (possibly missing ~ for float64 in Number)
```

The message names the likely fix. A slice is not comparable:

```go title="main.go"
package main

import "fmt"

func Index[T comparable](xs []T, want T) int {
	for i, x := range xs {
		if x == want {
			return i
		}
	}
	return -1
}

func main() {
	fmt.Println(Index([][]int{{1}}, []int{1}))
}
```

```text
./main.go:15:19: []int does not satisfy comparable
```

A constraint with type terms cannot be used as an ordinary type, since a variable of type
`Number` would have no single type:

```text
./main.go:10:8: cannot use type Number outside a type constraint: interface contains type constraints
```

## comparable and interface values

An interface type satisfies `comparable` (since Go 1.20), because `==` on interface values
is defined. But the comparison is checked at run time: it panics when both dynamic types
are the same uncomparable type.

```go title="main.go"
package main

import "fmt"

func Index[T comparable](xs []T, want T) int {
	for i, x := range xs {
		if x == want {
			return i
		}
	}
	return -1
}

func main() {
	vals := []any{1, "a", []int{1}}
	fmt.Println(Index(vals, any(1)))
	fmt.Println(Index(vals, any([]int{1})))
}
```

```text
0
panic: runtime error: comparing uncomparable type []int

goroutine 1 [running]:
main.Index[...](...)
	.../main.go:7
main.main()
	.../main.go:17 +0x1ad
exit status 2
```

The first call returns at index 0 before it reaches the slice. The second compares
`[]int{1}` with `[]int{1}` and panics. `comparable` guarantees `==` compiles, not that it
cannot panic when `T` is an interface.

> [!WARNING]
> Forgetting `~` rejects every defined type built on your constraint's types. Symptom:
> `X does not satisfy Number (possibly missing ~ ...)` for `time.Duration`, `Celsius`,
> your own `type ID int`. Fix: write `~int`, not `int`, unless you really mean only
> the predeclared type.

## Choosing a constraint

| You need in the body | Constraint |
|---|---|
| Nothing: store, pass, return | `any` |
| `==`, `!=`, use as a map key | `comparable` |
| `<`, `>`, `min`, `max`, sorting | `cmp.Ordered` |
| `+`, `-`, `*`, `/` | a union of numeric types you list, with `~` |
| A method | an interface with that method |
| A method on the value and a type shape | an interface with both (`Stringish` above) |

> [!NOTE]
> There is no standard numeric constraint in the standard library. `golang.org/x/exp/constraints`
> had one, but it is experimental; copy the few lines you need into your package, as
> `Number` is above. Prefer the smallest constraint that lets the body compile.

Keep constraints small and local. A method-based constraint is the generic form of the
small interfaces from [[implicit-interfaces]]. [[self-constraints]] shows constraints that
refer to the type parameter itself.
