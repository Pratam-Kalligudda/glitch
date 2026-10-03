---
title: Generic types
done_when: "You can declare a generic struct with methods, instantiate it with different type arguments, and explain why Stack[int] and Stack[int64] are different types."
---
Functions are not the only thing that takes type parameters. A **generic type** is a type
declaration with a type parameter list, such as a set, a stack or a cache that works for any
element type. The standard library has few of them (`atomic.Pointer[T]` and `iter.Seq[V]` are
two), because most collections are already built in: slices and maps. You write
generic types for the containers Go does not have.

```go title="main.go"
package main

import "fmt"

// Set is a collection of unique values.
type Set[T comparable] struct {
	items map[T]struct{}
}

func NewSet[T comparable](vals ...T) *Set[T] {
	s := &Set[T]{items: make(map[T]struct{}, len(vals))}
	for _, v := range vals {
		s.Add(v)
	}
	return s
}

// The receiver repeats the type parameter list; the names need not match the type's.
func (s *Set[T]) Add(v T) { s.items[v] = struct{}{} }

func (s *Set[E]) Has(v E) bool {
	_, ok := s.items[v]
	return ok
}

func (s *Set[T]) Len() int { return len(s.items) }

// Stack works for any element type.
type Stack[T any] struct {
	items []T
}

func (s *Stack[T]) Push(v T) { s.items = append(s.items, v) }

func (s *Stack[T]) Pop() (T, bool) {
	var zero T
	if len(s.items) == 0 {
		return zero, false
	}
	v := s.items[len(s.items)-1]
	s.items = s.items[:len(s.items)-1]
	return v, true
}

// Pair has two type parameters.
type Pair[K comparable, V any] struct {
	Key K
	Val V
}

func main() {
	seen := NewSet("a", "b", "a")
	fmt.Println(seen.Len(), seen.Has("a"), seen.Has("z"))

	var st Stack[int] // the zero value is ready to use
	st.Push(1)
	st.Push(2)
	v, ok := st.Pop()
	fmt.Println(v, ok)
	st.Pop()
	v, ok = st.Pop()
	fmt.Println(v, ok)

	p := Pair[string, int]{"age", 30}
	fmt.Printf("%v %+v %T\n", p, p, p)
	fmt.Printf("%T %T\n", seen, &st)
}
```

```bash
go run .
```

```text
2 true false
2 true
0 false
{age 30} {Key:age Val:30} main.Pair[string,int]
*main.Set[string] *main.Stack[int]
```

## How it works

**A generic type is a template, not a type.** `Stack` alone is not a type; `Stack[int]` is.
Naming a type with its type arguments is **instantiation**. Every instantiation is a
distinct type, and two instantiations with different arguments are unrelated:
`Stack[int]` and `Stack[int64]` cannot be assigned to each other, just as `int` and `int64`
cannot. The `%T` output shows the instantiated name, `main.Stack[int]`.

**Methods repeat the type parameters in the receiver.** `func (s *Stack[T]) Push(v T)`
declares `T` for this method and binds it to the receiver's type argument. You choose the
names: `Has` uses `E`. Using the same name everywhere is clearer. The receiver lists names
only, with no constraints; the constraints come from the type declaration.

**The constraint on the type applies to every method.** `Set[T comparable]` lets every
method use `==` and `T` as a map key. That is what makes `map[T]struct{}` legal: map keys
must be comparable.

**Zero values work.** `var st Stack[int]` is a usable stack, because a nil slice appends
fine ([[slices-internals]]). Design generic types, as you design any type, so the zero value
is useful. The `Set` is the exception, since a nil map panics on write; that is why it has
`NewSet`.

**Returning "nothing" uses a zero value.** `Pop` returns `T`, and there is no `nil` for an
arbitrary `T`, so it declares `var zero T`, returns it with `false`, and the caller reads the
bool. This is the comma-ok pattern from [[maps]] and channel receives, applied to a generic
type.

## What the compiler rejects

```go title="main.go"
package main

import "fmt"

type Stack[T any] struct{ items []T }

func (s *Stack[T]) Push(v T) { s.items = append(s.items, v) }

func main() {
	var a Stack[int]
	var b Stack[int64]
	a.Push(1)
	b = a
	fmt.Println(a, b)
	var s Stack
	_ = s
}
```

```text
./main.go:13:6: cannot use a (variable of struct type Stack[int]) as Stack[int64] value in assignment
./main.go:15:8: cannot use generic type Stack[T any] without instantiation
```

Unlike functions, generic types are never inferred from a declaration: you always write
the type arguments for a variable, field or parameter type. Inference only helps at function
calls and, since Go 1.27, when assigning a generic function to a typed variable
([[inference]]). You can hide the argument by writing a constructor: `NewSet("a", "b")` infers
`T` from its arguments, so callers write no brackets.

## A recursive generic type

A generic type may refer to itself and to other generic types, always with its arguments:

```go title="main.go"
package main

import "fmt"

type List[T any] struct {
	head *node[T]
}

type node[T any] struct {
	val  T
	next *node[T]
}

func (l *List[T]) Prepend(v T) { l.head = &node[T]{v, l.head} }

func (l *List[T]) Each(f func(T)) {
	for n := l.head; n != nil; n = n.next {
		f(n.val)
	}
}

// Strings is a generic type alias (Go 1.24).
type Strings[T ~string] = List[T]

func main() {
	var l List[string]
	l.Prepend("b")
	l.Prepend("a")
	l.Each(func(s string) { fmt.Println(s) })

	var x Strings[string]
	x.Prepend("z")
	fmt.Printf("%T\n", x)
}
```

```text
a
b
main.List[string]
```

`node[T]` is unexported but `List[T]` exposes it only through its methods: callers never see
the node. The alias `Strings[T]` is another name for `List[T]`: `%T` prints the real type.
Since Go 1.24 an alias may have type parameters; it exists mainly to rename or restrict an
instantiation while migrating a package, and you will rarely need one.

Note what `Each` cannot do: it cannot take a type parameter of its own, so a method such as
`Map[U any](f func(T) U) *List[U]` is not possible on a `List[T]` in older Go. Go 1.27 lifts
this for methods; see [[generic-methods]]. Callers can also ask a type for its elements as
an iterator rather than through a callback like `Each`; [[writing-iterators]] shows how.

> [!WARNING]
> A constraint that is too loose breaks at the first method that needs more. Symptom:
> `invalid operation: v == v (incomparable types in type set)` inside a method, and
> `invalid map key type T (missing comparable constraint)` on the field. Fix: tighten the
> type declaration's constraint (`Set[T comparable]`), not the method; methods cannot add
> constraints of their own.

> [!NOTE]
> A field whose type is a type parameter, such as `Val V`, works with any constraint. But a
> struct cannot embed a type parameter (`struct{ T }`): the compiler reports `embedded field
> type cannot be a (pointer to a) type parameter`.

linkcheck keeps its visited URLs in a `Set[string]` built exactly like this, in
[[step-2-crawl]].
