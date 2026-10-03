---
title: Value and pointer receivers
---
A method's **receiver** is the value it is called on, declared before the method name:
`func (c Counter) String()` has a **value receiver**, `func (c *Counter) Inc()` a
**pointer receiver**. The choice decides whether the method can change the caller's value,
and it also decides the type's **method set**: the set of methods a type has for the
purpose of satisfying an interface. Most "does not implement" errors in Go come from this
one rule, so it is worth knowing exactly.

## The two receivers side by side

```go title="main.go"
package main

import "fmt"

type Counter struct {
	name string
	n    int
}

// Value receiver: works on a copy.
func (c Counter) String() string { return fmt.Sprintf("%s=%d", c.name, c.n) }

// Pointer receiver: works on the caller's Counter.
func (c *Counter) Inc() { c.n++ }

// IncCopy has a value receiver, so its increment is lost.
func (c Counter) IncCopy() { c.n++ }

func main() {
	c := Counter{name: "links"}
	c.Inc()     // Go rewrites this to (&c).Inc()
	c.IncCopy() // increments a copy
	fmt.Println(c.String(), c.n)

	p := &c
	p.Inc()
	fmt.Println(p.String()) // Go rewrites this to (*p).String()

	counters := []Counter{{name: "a"}, {name: "b"}}
	for _, ct := range counters {
		ct.Inc() // ct is a copy of the element
	}
	fmt.Println(counters)
	for i := range counters {
		counters[i].Inc() // the element itself
	}
	fmt.Println(counters)

	var s fmt.Stringer = c // Counter has String: its method set includes it
	fmt.Println(s)
}
```

```bash
go run .
```

```text
links=1 1
links=2
[a=0 b=0]
[a=1 b=1]
links=2
```

## How it works: a receiver is a parameter

A method is a function whose first parameter is the receiver, and parameters are passed by
value ([[pointers]]). `Counter.IncCopy` gets a copy of the struct, so its `c.n++` is lost.
`(*Counter).Inc` gets a copy of a pointer, and writes through it. In the first `for` loop,
`ct` is itself a copy of each element, so even the pointer method incremented the copy.
Indexing, `counters[i].Inc()`, reaches the element.

**The call shorthand.** You called `c.Inc()` on a `Counter` variable, not a pointer. Go
rewrites `c.Inc()` to `(&c).Inc()` when `c` is **addressable**: a variable, a struct field
of an addressable struct, a slice element, or a dereferenced pointer. In the other direction,
`p.String()` on a `*Counter` becomes `(*p).String()`, which always works because a pointer
can always be dereferenced.

## How it works: method sets

The shorthand works for calls on addressable values. It does not apply where Go has no
variable to take the address of, and **interfaces** are the main such place. The rule, from
the language specification:

| Type | Method set contains |
|---|---|
| `T` | Methods with receiver `T` |
| `*T` | Methods with receiver `T` **and** methods with receiver `*T` |

An **interface** is a set of method signatures; a type satisfies it when its method set
contains them all (interfaces are taught in [[implicit-interfaces]]). `Counter`'s method set
is `{String, IncCopy}`; `*Counter`'s is `{String, IncCopy, Inc}`. So a `Counter` value is a
`fmt.Stringer`, but only a `*Counter` can be something with an `Inc()` method:

```go title="e/e.go"
package e

type Counter struct{ n int }

func (c *Counter) Inc() { c.n++ }

type Incrementer interface {
	Inc()
}

func errors() {
	var c Counter
	var i Incrementer = c
	m := map[string]Counter{"a": {}}
	m["a"].Inc()
	Counter{}.Inc()
	_ = i
}
```

```text
# example.com/msets/e
e\e.go:13:22: cannot use c (variable of struct type Counter) as Incrementer value in variable declaration: Counter does not implement Incrementer (method Inc has pointer receiver)
e\e.go:15:9: cannot call pointer method Inc on Counter
e\e.go:16:12: cannot call pointer method Inc on Counter
```

Why the rule exists: an interface value stores a **copy** of what you put in it. If a
`Counter` value in an interface could run `Inc`, the method would modify that hidden copy,
and the caller's `Counter` would never change: a silent bug. Go refuses instead. The fix is
to store the pointer: `var i Incrementer = &c`.

Lines 15 and 16 are the addressability rule. A map element is not addressable ([[maps]]),
and neither is a composite literal used as a value, so there is no address for `Inc` to
receive. Store pointers in the map, or read, modify, write back.

**Embedding** follows the same rule for promoted methods ([[structs-embedding]]):

| Struct | Method set of `S` | Method set of `*S` |
|---|---|---|
| `type S struct{ T }` | Promoted `T` methods | Promoted `T` and `*T` methods |
| `type S struct{ *T }` | Promoted `T` and `*T` methods | Promoted `T` and `*T` methods |

So with `type ByValue struct{ Counter }`, `&ByValue{}` is an `Incrementer` and `ByValue{}`
is not:

```text
emb\e.go:15:18: cannot use ByValue{} (value of struct type ByValue) as Incrementer value in variable declaration: ByValue does not implement Incrementer (method Inc has pointer receiver)
```

## Choosing a receiver

Use a pointer receiver when any of these is true:

- The method modifies the receiver.
- The struct contains something that must not be copied, such as a `sync.Mutex` (`go vet`'s
  `copylocks` check reports value receivers on such types, see [[vet-fmt-fix]]).
- The struct is large enough that copying it on every call matters.

Use a value receiver for small, immutable values: `time.Time`, a `Celsius`, a 2D point.
And be **consistent**: if any method needs a pointer receiver, give all methods of that type
pointer receivers. Mixed receivers make the method sets of `T` and `*T` differ in ways
callers have to remember.

> [!WARNING]
> A method with a value receiver that "updates" the receiver compiles and does nothing. The
> symptom is a counter, cache or flag that never changes, like `IncCopy` above, with no
> error anywhere. The reverse mistake, putting a `T` where an interface needs a method with
> a `*T` receiver, at least fails to compile with
> `does not implement ... (method Inc has pointer receiver)`. In both cases the fix is the
> same: pointer receivers for mutating methods, and pass `&v` where the interface is
> needed.

> [!NOTE]
> A pointer receiver may be `nil`: `var p *Counter; p.Inc()` calls `Inc` with `c == nil`,
> and only panics when `Inc` dereferences it. Some types use this deliberately, checking
> `if c == nil` first. Go 1.27 also lets methods declare their own type parameters; that is
> covered in [[generic-methods]].

Give every linkcheck type that holds a mutex or a map pointer receivers, starting with the
visited set in [[step-2-crawl]].
