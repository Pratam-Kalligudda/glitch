---
title: Pointers and new
---
A **pointer** holds the address of a variable. `*T` is the type "pointer to a `T`", `&x`
takes the address of `x`, and `*p` reads or writes the variable `p` points to. Go passes
everything by value, so a pointer is how a function changes a variable that belongs to its
caller, how large values are shared without copying, and how a field says "not set" as
distinct from "set to zero". Go pointers are deliberately limited: no arithmetic, no
dangling pointers, and the garbage collector decides where variables live.

## Pointers at work

```go title="main.go"
package main

import (
	"fmt"
	"time"
)

type Config struct {
	MaxDepth *int           // nil means "use the default"
	Timeout  *time.Duration // nil means "no timeout set"
}

type Page struct {
	URL    string
	Status int
}

func markBroken(p Page)     { p.Status = 404 }
func markBrokenPtr(p *Page) { p.Status = 404 }

func newPage(url string) *Page {
	p := Page{URL: url} // a local variable...
	return &p           // ...that outlives the call: perfectly safe
}

func main() {
	n := 3
	ptr := &n
	*ptr = 4
	fmt.Println(n, *ptr, ptr != nil)

	p := Page{URL: "/a", Status: 200}
	markBroken(p)
	fmt.Println(p.Status)
	markBrokenPtr(&p)
	fmt.Println(p.Status)

	q := newPage("/b")
	q.Status = 301 // q.Status is (*q).Status
	fmt.Println(*q)

	zero := new(int) // pointer to a new zero int
	depth := new(5)  // Go 1.26: pointer to a new int holding 5
	timeout := new(10 * time.Second)
	cfg := Config{MaxDepth: depth, Timeout: timeout}
	fmt.Println(*zero, *cfg.MaxDepth, *cfg.Timeout)

	var unset Config
	fmt.Println(unset.MaxDepth == nil)

	a, b := new(1), new(1)
	fmt.Println(a == b, *a == *b)
}
```

```bash
go run .
```

```text
4 4 true
200
404
{/b 301}
0 5 10s
true
false true
```

## How it works

**Everything is passed by value.** `markBroken(p)` received a copy of the `Page`; setting
the copy's `Status` did nothing to the caller's `p`. `markBrokenPtr(&p)` received a copy of
the *address*, and through it wrote the caller's variable. That is the whole mechanism:
there are no reference parameters, only values, some of which are addresses.

**Selectors dereference for you.** `q.Status` on a `*Page` means `(*q).Status`. The same
shorthand applies to method calls, which [[method-sets]] builds on.

**Returning the address of a local is safe.** In C, `newPage` would return a dangling
pointer. In Go, the compiler's **escape analysis** sees that `p` is still reachable after
the function returns and allocates it on the heap instead of the stack; the garbage
collector frees it when nothing points to it any more. You never choose stack or heap
yourself, and you can see the compiler's decisions with `go build -gcflags=-m`
([[escape-analysis]]).

**`new`.** `new(T)` allocates a zero `T` and returns its address: `new(int)` is a `*int`
pointing at 0. Since Go 1.26, the operand may also be an expression: `new(5)` allocates an
`int` holding 5, `new(10 * time.Second)` a `time.Duration` holding 10s. The type is the
expression's type (an untyped constant gets its default type, see [[constants-iota]]), and
the value is copied into the new variable. Before Go 1.26 you needed a helper like
`func ptr[T any](v T) *T { return &v }` or a temporary variable for this; `go fix`'s
`newexpr` fixer replaces such helpers ([[vet-fmt-fix]]).

**Pointer equality is identity.** `a == b` compares addresses: two separate `new(1)` calls
make two variables, so the pointers differ while the values are equal.

**Optional fields.** A `*int` field can be `nil` ("not set") or point at any value,
including 0. That is the usual way to tell "the user asked for depth 0" from "the user said
nothing" in config structs and JSON. The cost is a nil check at every read.

**What Go does not allow.**

```go title="e/e.go"
package e

func errors() {
	p := &5
	n := 1
	q := &n
	q++
	_ = p
}
```

```text
# example.com/ptrs/e
e\e.go:4:8: invalid operation: cannot take address of 5 (untyped int constant)
e\e.go:7:2: invalid operation: q++ (non-numeric type *int)
```

Constants have no address (use `new(5)`), and there is no pointer arithmetic outside the
`unsafe` package. `&` works on variables, struct fields, slice elements and array elements
of addressable arrays, and, as a special case, on composite literals: `&Page{URL: "/c"}`.

The `new(expr)` form follows the module's language version. In a module that says
`go 1.25`:

```text
# example.com/ptrs/e
e\e.go:3:24: new(5) requires go1.26 or later (-lang was set to go1.25; check go.mod)
```

## The nil pointer

```go title="nilp/main.go"
package main

import "fmt"

type Config struct {
	MaxDepth *int
}

func depth(c Config) int {
	return *c.MaxDepth
}

func depthOr(c Config, def int) int {
	if c.MaxDepth == nil {
		return def
	}
	return *c.MaxDepth
}

func main() {
	var c Config
	fmt.Println(depthOr(c, 3))
	fmt.Println(depth(c))
}
```

```text
3
panic: runtime error: invalid memory address or nil pointer dereference
[signal 0xc0000005 code=0x0 addr=0x0 pc=0x7ff63d235257]

goroutine 1 [running]:
main.depth(...)
	.../nilp/main.go:10
```

(Windows output, path shortened; Linux and macOS print `SIGSEGV` on the signal line.)

> [!WARNING]
> Dereferencing a `nil` pointer panics with
> `invalid memory address or nil pointer dereference`, and the trace points at the line that
> dereferenced, not the code that forgot to set the pointer. Every optional pointer field
> needs a nil check, or an accessor like `depthOr` that applies the default in one place.
> When a field does not need a "not set" state, do not make it a pointer: a plain `int` with
> a meaningful zero value (see [[zero-values]]) cannot be nil.

| You want | Use |
|---|---|
| A function that modifies the caller's value | Pass `*T` |
| To avoid copying a large struct | Pass `*T` (measure first; copying small structs is cheap) |
| An optional value distinct from zero | `*T` field, `nil` means unset |
| A pointer to a fresh value | `&T{...}` for structs, `new(v)` for anything (Go 1.26) |
| A value that must not be shared | Pass `T` |

> [!NOTE]
> Slices, maps, channels, functions and interfaces already contain pointers internally, so
> you rarely need a pointer to one of them. What exactly is shared when you copy each kind
> of value is summarised in [[copying]].

In [[step-5-filters]], linkcheck reads a JSON config file. Decide for each option whether
"unset" must differ from zero, and use a pointer only where it must.
