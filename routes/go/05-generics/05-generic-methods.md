---
title: Generic methods
done_when: "You can declare a method with its own type parameters (Go 1.27), call it with inferred and explicit type arguments, and explain why it cannot satisfy an interface method."
---
(Go 1.27) A method may declare its own type parameters, in addition to the type parameters
of its receiver. Until Go 1.27 this was a compile error, and the only way to write
"`List[T]` converted to `List[U]`" was a package-level function that took the list as its
first argument. A **generic method** puts that function back inside the type's namespace.

```go title="main.go"
package main

import (
	"fmt"
	"strings"
)

type List[T any] struct {
	items []T
}

func (l *List[T]) Append(v T) { l.items = append(l.items, v) }

// Map has its own type parameter U besides the receiver's T.
func (l *List[T]) Map[U any](f func(T) U) *List[U] {
	out := &List[U]{items: make([]U, 0, len(l.items))}
	for _, v := range l.items {
		out.Append(f(v))
	}
	return out
}

// Fold shows a type parameter that only the caller's function mentions.
func (l *List[T]) Fold[A any](init A, f func(A, T) A) A {
	acc := init
	for _, v := range l.items {
		acc = f(acc, v)
	}
	return acc
}

// A non-generic type may have generic methods too.
type Registry struct {
	names []string
}

func (r *Registry) Describe[T fmt.Stringer](v T) string {
	s := v.String()
	r.names = append(r.names, s)
	return strings.ToUpper(s)
}

type Color int

func (c Color) String() string { return [...]string{"red", "green"}[c] }

func main() {
	var words List[string]
	words.Append("go")
	words.Append("gopher")

	lens := words.Map(func(s string) int { return len(s) }) // U inferred
	fmt.Println(lens.items)

	total := words.Fold(0, func(n int, s string) int { return n + len(s) })
	fmt.Println(total)

	explicit := words.Map[bool](func(s string) bool { return len(s) > 2 })
	fmt.Println(explicit.items)

	var r Registry
	fmt.Println(r.Describe(Color(1)), r.names)

	fn := words.Map[string] // a method value needs every type argument
	fmt.Printf("%T\n", fn)
}
```

```bash
go run .
```

```text
[2 6]
8
[false true]
GREEN [green]
func(func(string) string) *main.List[string]
```

## How it works

**Two kinds of type parameter.** The receiver `(l *List[T])` binds `T`, exactly as in
[[generic-types]]. The method's own list, `Map[U any]`, follows the method name and binds
`U` for that method alone. Names must differ: a method that reuses `T` fails with
`T redeclared in this block`. Both are in scope in the body, so `Map` can build a `*List[U]`
from `T` values.

**Calls use the same inference as functions.** `words.Map(func(s string) int {...})` infers
`U = int` from the function argument ([[inference]]). `words.Map[bool](...)` gives it
explicitly. Only the method's own parameters are written in brackets; the receiver's `T` is
already known from the variable's type.

**The rule is plain syntax plus the language version.** The method's constraints work as for
a function. A generic method works on any named type, generic or not: `Registry` is an
ordinary struct, and `Describe[T fmt.Stringer]` is bound to it. The feature needs `go 1.27`
in `go.mod`. With `go 1.26` the same file fails to build:

```text
f/main.go:7:22: generic method requires go1.27 or later (-lang was set to go1.26; check go.mod)
```

## What a generic method cannot do

The release notes state the restrictions: an interface method cannot declare type
parameters, and a generic method cannot implement an interface method. The reason is how
interfaces work. An interface call is dispatched at run time through a method table, and
that table holds one function per method. A generic method is not one function but one per
type argument, and the call site does not know which one the interface value would need.

Declaring one in an interface:

```go title="main.go"
package main

import "fmt"

type Mapper interface {
	Map[U any](f func(int) U) []U
}

func main() { fmt.Println("hi") }
```

```text
./main.go:6:5: interface method must have no type parameters
./main.go:6:25: undefined: U
```

Trying to satisfy an ordinary interface method with a generic one:

```go title="main.go"
package main

import "fmt"

type Printer interface {
	Print(v any)
}

type Console struct{}

func (Console) Print[T any](v T) { fmt.Println(v) }

func main() {
	var p Printer = Console{}
	p.Print(1)
}
```

```text
./main.go:14:18: cannot use Console{} (value of struct type Console) as Printer value in variable declaration: Console does not implement Printer (wrong type for method Print)
		have Print[T any](T)
		want Print(any)
```

`Print[T any](T)` and `Print(any)` look equivalent but are different methods: the first
needs a type argument, and an interface method set holds none. If an interface needs it,
write a non-generic method with the loosest parameter type (`Print(v any)`) and keep the
generic one as an extra.

A generic method is also not a value until you give it every type argument:

```go title="main.go"
package main

import "fmt"

type Console struct{}

func (Console) Print[T any](v T) { fmt.Println(v) }

func main() {
	var c Console
	c.Print(1)
	c.Print("x")
	f := c.Print
	_ = f
}
```

```text
./main.go:13:7: cannot use generic function c.Print without instantiation
```

`c.Print[int]` is a value, as `words.Map[string]` was above, with the method's own type
arguments filled in.

## When to use one

Use a generic method when an operation belongs to a type, reads better as `list.Map(f)` than
`Map(list, f)`, and needs a type that the receiver does not have. The Go 1.27 release notes
show one in the standard library: `(*rand.Rand).N` in `math/rand/v2`, a method that takes any integer type.

Do not reach for it when a package-level generic function works as well. The function form
also works in older Go and can be passed around. Prefer the function when the type is
nothing but a bag for the call, and the method when the receiver carries state the method
uses or updates, like `Registry` does.

> [!WARNING]
> Adding a generic method to a type you expected to satisfy an interface does not make it
> satisfy it. Symptom: `does not implement ... (wrong type for method ...)` with a `have`
> line showing the type parameter list. Fix: add a non-generic method with the interface's
> exact signature, or define the interface around a method that takes `any`, or a concrete
> type, instead.

> [!NOTE]
> Programs that use generic methods need Go 1.27 or later in `go.mod`. Authors of
> libraries that must still build with older Go keep package-level generic functions.

[[self-constraints]] returns to type parameters that refer to themselves.
