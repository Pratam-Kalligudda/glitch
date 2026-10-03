---
title: Defined types and aliases
---
`type Celsius float64` creates a **defined type**: a brand-new type, distinct from every
other type, that happens to store a `float64`. You use defined types to give a value a
meaning the compiler can check (a `Celsius` is not a `Fahrenheit`, a `UserID` is not an
`OrderID`) and to attach methods to it. `type Temperature = Celsius`, with an `=`, does
something else entirely: it creates an **alias**, a second name for the same type. The two
look almost the same and behave in opposite ways.

## Defined types, conversions and an alias

```go title="main.go"
package main

import (
	"fmt"
	"strings"
)

// Celsius and Fahrenheit share an underlying type but are different types.
type Celsius float64
type Fahrenheit float64

func (c Celsius) Fahrenheit() Fahrenheit { return Fahrenheit(c*9/5 + 32) }

func (c Celsius) String() string { return fmt.Sprintf("%.1f°C", float64(c)) }

// URLs is a defined slice type with its own methods.
type URLs []string

func (u URLs) Hosts() []string {
	var hosts []string
	for _, s := range u {
		s = strings.TrimPrefix(s, "https://")
		host, _, _ := strings.Cut(s, "/")
		hosts = append(hosts, host)
	}
	return hosts
}

// Temperature is an alias: another name for Celsius, not a new type.
type Temperature = Celsius

func main() {
	boil := Celsius(100)
	fmt.Println(boil, boil.Fahrenheit())

	var t Temperature = boil // no conversion needed: same type
	fmt.Println(t.Fahrenheit())
	fmt.Printf("%T %T\n", boil, t)

	f := Fahrenheit(boil) // explicit conversion between defined types
	fmt.Println(f)

	links := URLs{"https://go.dev/doc", "https://pkg.go.dev/fmt"}
	fmt.Println(links.Hosts())

	var raw []string = links // assignable: identical underlying type, one side not named
	fmt.Println(len(raw))
}
```

```bash
go run .
```

```text
100.0°C 212
212
main.Celsius main.Celsius
100
[go.dev pkg.go.dev]
2
```

## How it works

**Every type has an underlying type.** For a predeclared type like `float64`, or a type
literal like `[]string` or `struct{ X int }`, the underlying type is itself. For
`type Celsius float64`, the underlying type is `float64`. The underlying type decides what
the value looks like in memory and which operators work: `Celsius` supports `+`, `*` and
`<` because `float64` does.

**A defined type is different from every other type**, including its own underlying type
and every other type defined over the same underlying type. So the compiler refuses to mix
them:

```go title="e/e.go"
package e

import (
	"sync"
	"time"
)

type Celsius float64
type Fahrenheit float64

type Locker sync.Mutex

func (d time.Duration) Double() time.Duration { return 2 * d }

func errors() {
	var c Celsius = 20
	var f Fahrenheit = 68
	x := 1.5
	_ = c + f
	_ = c * x
	var l Locker
	l.Lock()
}
```

```text
# example.com/deftypes/e
e\e.go:13:9: cannot define new methods on non-local type time.Duration
e\e.go:19:6: invalid operation: c + f (mismatched types Celsius and Fahrenheit)
e\e.go:20:6: invalid operation: c * x (mismatched types Celsius and float64)
e\e.go:22:4: l.Lock undefined (type Locker has no field or method Lock)
```

Each line is a rule:

1. **Methods only on your own types.** You can declare methods only on a defined type from
   the same package. To add behaviour to `time.Duration` or `string`, define your own type
   over it.
2. **No implicit conversion.** `c + f` and `c * x` fail even though all three are `float64`
   underneath. Untyped constants are the exception (`c * 9 / 5` works, see
   [[constants-iota]]).
3. **Conversion is explicit, and it only relabels.** `T(x)` converts when `x` and `T` have
   the same underlying type (and in a few other cases, such as between numeric types or
   between `string` and `[]byte`). `Fahrenheit(boil)` printed `100`: the conversion changed
   the type, not the number. Unit conversion is your method's job, which is why
   `Celsius.Fahrenheit` exists.
4. **A defined type does not inherit methods.** `Fahrenheit` printed as a bare `212`,
   because only `Celsius` has a `String` method. `type Locker sync.Mutex` copies the
   mutex's fields but none of its methods, so `l.Lock` does not exist. To keep methods,
   embed the type in a struct instead (see [[structs-embedding]]).

**Assignability.** A value of type `V` can be assigned to a variable of type `T` without
conversion when they are identical, or when they have identical underlying types and at
least one of them is not a named type. `URLs` to `[]string` works for that reason: `[]string`
is a type literal, not a named type. `Celsius` to `Fahrenheit` does not: both are named.

## Aliases

`type Temperature = Celsius` declares no new type. `Temperature` and `Celsius` are the
same type with two names: no conversion, same methods, and `%T` prints `main.Celsius` for
both. Aliases exist for one main job: **moving a type between packages without breaking
callers**. When a type moves from `oldpkg` to `newpkg`, `oldpkg` keeps
`type Client = newpkg.Client`, and old code keeps compiling. The standard library uses them
the same way: `byte` is an alias for `uint8`, `rune` for `int32`, `any` for `interface{}`.

| Declaration | New type? | Methods of the right side | Needs conversion |
|---|---|---|---|
| `type C float64` | Yes | None (you add your own) | Yes, to and from `float64` |
| `type C = float64` | No | All of them (it is the same type) | No |
| `type Locker sync.Mutex` | Yes | None | Yes |
| `type Locker struct{ sync.Mutex }` | Yes | Promoted from the embedded field | Not applicable |

> [!WARNING]
> Defining a type over another named type to "extend" it silently drops every method.
> The symptom is `x.Method undefined (type T has no field or method Method)` for a method
> the original type clearly has, or, worse, a type that stops satisfying an interface such
> as `fmt.Stringer` and starts printing raw values. Embed the original in a struct when you
> want its methods; define over it only when you want a fresh, method-free type.

> [!NOTE]
> Since Go 1.24 aliases may have type parameters:
> `type Set[T comparable] = map[T]struct{}`. Type parameters are covered from
> [[type-parameters]] on.

Defined types with methods are how linkcheck models its domain: its visited-URL set in
[[step-2-crawl]] is a defined type with methods, not a bare map.
