---
title: Interface values and the nil trap
done_when: "You can explain why a function that returns a nil `*T` as an `error` makes `err != nil` true, and you return a literal `nil` instead."
---
A variable of interface type holds two things: the **dynamic type** (the concrete type of
the value stored in it) and the **dynamic value** (that value, or a pointer to it). The
interface's own type, such as `error` or `any`, is its **static type** and never changes.
An interface value is `nil` only when *both* parts are unset. Almost every surprise with
interfaces, including the most famous Go bug, follows from that pair.

## Seeing the two words

The program below copies the runtime's layout of an `any` value into a struct of two
pointers, so you can see which word is set. This uses `unsafe` and an internal layout; it
is a teaching aid, not something to put in real code.

```go title="main.go"
package main

import (
	"fmt"
	"unsafe"
)

// eface mirrors the runtime's layout of an empty interface (any): two machine words.
// This is an implementation detail, shown here only to make the pair visible.
type eface struct {
	typ  unsafe.Pointer
	data unsafe.Pointer
}

func words(label string, v any) {
	e := (*eface)(unsafe.Pointer(&v))
	fmt.Printf("%-22s type word set: %-5t  data word set: %-5t  %%T=%-14T v==nil: %t\n",
		label, e.typ != nil, e.data != nil, v, v == nil)
}

type point struct{ x, y int }

func main() {
	var p *point
	words("var v any", nil)
	words("42", 42)
	words("point{1, 2}", point{1, 2})
	words("(*point)(nil)", p)
	words("&point{3, 4}", &point{3, 4})
	fmt.Println("size of an interface value:", unsafe.Sizeof(any(nil)), "bytes")

	// Assigning to an interface copies the value.
	pt := point{1, 2}
	var held any = pt
	pt.x = 100
	fmt.Println("original:", pt, "copy in interface:", held)
}
```

```bash
go run .
```

```text
var v any              type word set: false  data word set: false  %T=<nil>          v==nil: true
42                     type word set: true   data word set: true   %T=int            v==nil: false
point{1, 2}            type word set: true   data word set: true   %T=main.point     v==nil: false
(*point)(nil)          type word set: true   data word set: false  %T=*main.point    v==nil: false
&point{3, 4}           type word set: true   data word set: true   %T=*main.point    v==nil: false
size of an interface value: 16 bytes
original: {100 2} copy in interface: {1 2}
```

The size is 16 bytes on a 64-bit platform: two 8-byte words.

## How it works

- The **type word** points to the runtime's description of the dynamic type. For an empty
  interface (`any`) it is a type descriptor. For an interface with methods, such as
  `error`, it points to an **itab**: the type descriptor plus a table of function pointers
  for that type's implementation of the interface's methods. A method call through an
  interface loads the function from the itab and calls it with the data word as the
  receiver. That indirection is called dynamic dispatch.
- The **data word** points to the value. A pointer-shaped value (a pointer, a map, a
  channel) is stored in the word directly; other values are copied to memory the
  interface points to. Either way, storing a value in an interface **copies** it, which is
  why changing `pt` afterwards does not change `held`.
- `(*point)(nil)` is the key row. The data word is nil, but the type word says
  `*main.point`. `v == nil` compares the whole pair against the nil interface value (no
  type, no value), so it is `false`.

## The nil trap

The pair matters most for `error`, because functions return it on every path and callers
test `err != nil`. Here a helper returns a concrete pointer type, and its nil leaks into an
`error`:

```go title="main.go"
package main

import (
	"fmt"
	"strings"
)

type ValidationError struct {
	Field string
}

func (e *ValidationError) Error() string {
	return "invalid " + e.Field
}

// validate returns a concrete pointer type. That is the bug.
func validate(name string) *ValidationError {
	if strings.TrimSpace(name) == "" {
		return &ValidationError{Field: "name"}
	}
	return nil
}

func save(name string) error {
	err := validate(name) // err has type *ValidationError
	return err            // converted to error: (type=*ValidationError, value=nil)
}

func main() {
	err := save("gopher")
	fmt.Printf("err == nil: %t\n", err == nil)
	fmt.Printf("dynamic type: %T, value: %v\n", err, err)
	if err != nil {
		fmt.Println("save failed:", err.Error())
	}
}
```

```bash
go run .
```

```text
err == nil: false
dynamic type: *main.ValidationError, value: <nil>
panic: runtime error: invalid memory address or nil pointer dereference

goroutine 1 [running]:
main.(*ValidationError).Error(...)
	/home/you/niltrap/main.go:13
main.main()
	/home/you/niltrap/main.go:34 +0x102
exit status 2
```

The panic header also prints a `[signal ...]` line whose text depends on the operating
system; it is left out above, and the file paths will be yours.

"gopher" is a valid name, yet `save` reports failure. `validate` returned a nil
`*ValidationError`. The `return err` in `save` converts it to `error`, producing the pair
(type `*ValidationError`, value nil). That pair is not the nil interface, so `err != nil`
is true. `fmt` printed `<nil>` because it recovers from a panic in an `Error` method called
on a nil receiver and prints `<nil>` instead; the direct `err.Error()` call has no such
protection, dereferences `e`, and panics. `go vet` reports nothing here: the code is legal.

The fix is to make every function that can fail return the `error` interface, and to
write `return nil` on success, so the nil you return is the interface's own nil:

```go title="main.go"
package main

import (
	"fmt"
	"strings"
)

type ValidationError struct {
	Field string
}

func (e *ValidationError) Error() string {
	return "invalid " + e.Field
}

// validate now returns the error interface, and a literal nil on success.
func validate(name string) error {
	if strings.TrimSpace(name) == "" {
		return &ValidationError{Field: "name"}
	}
	return nil
}

func save(name string) error {
	if err := validate(name); err != nil {
		return err
	}
	return nil
}

func main() {
	for _, name := range []string{"gopher", "  "} {
		err := save(name)
		fmt.Printf("save(%q): err == nil: %t, err: %v\n", name, err == nil, err)
	}
}
```

```text
save("gopher"): err == nil: true, err: <nil>
save("  "): err == nil: false, err: invalid name
```

> [!WARNING]
> Never return a concrete error type (`*MyError`) from a function, and never assign a
> possibly-nil pointer to an `error` variable that you later compare with `nil`. Symptom:
> callers see a non-nil error that prints `<nil>`, or a nil pointer panic inside your
> `Error` method. Fix: declare the result as `error` and `return nil` on success. The same
> trap applies to any interface: a nil `*bytes.Buffer` stored in an `io.Writer` is a
> non-nil writer that panics on first use.

## Comparing interface values

Two interface values are equal when their dynamic types are identical and their dynamic
values are equal. Different dynamic types are simply unequal. But if both hold the same
type and that type is not comparable (a slice, map or function), the comparison panics at
run time, because the compiler could not see the types.

```go title="main.go"
package main

import "fmt"

type celsius float64
type fahrenheit float64

func main() {
	var a, b any = 3, 3
	fmt.Println("3 == 3:", a == b)

	var c, f any = celsius(20), fahrenheit(20)
	fmt.Println("celsius(20) == fahrenheit(20):", c == f) // different dynamic types

	var n any = 3
	fmt.Println("any(3) == 3:", n == 3) // 3 converts to any(int(3))

	seen := map[any]bool{}
	seen["go"] = true
	seen[42] = true
	fmt.Println("map with interface keys:", len(seen))

	var s1, s2 any = []int{1}, []int{1}
	fmt.Println("comparing two slices in interfaces...")
	fmt.Println(s1 == s2)
}
```

```text
3 == 3: true
celsius(20) == fahrenheit(20): false
any(3) == 3: true
map with interface keys: 2
comparing two slices in interfaces...
panic: runtime error: comparing uncomparable type []int

goroutine 1 [running]:
```

The same rule applies to maps with interface keys: `m[[]int{1}] = 1` on a `map[any]int`
compiles and panics with `runtime error: hash of unhashable type []int`. The spec also
applies it to arrays of interfaces and to structs with interface fields.

| Interface value | `== nil` | Method call |
|---|---|---|
| `var e error` (no type, no value) | true | panics: nil pointer dereference |
| `error((*MyErr)(nil))` | false | runs the method with a nil receiver |
| `error(&MyErr{})` | false | runs normally |

[[assertions-switches]] shows how to get the concrete value back out of the pair, and
[[sentinel-typed]] returns to the nil trap when you design your own error types.
