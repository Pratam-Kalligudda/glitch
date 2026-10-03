---
title: Stringer, error and fmt
done_when: "Your type prints a readable name with %v, the pointer-versus-value receiver trap no longer surprises you, and go vet reports no recursive String call."
---
`fmt` prints any value, but it does not print every value the same way. Before falling
back to its default formatting, it checks whether the operand implements one of a few
interfaces, and if so lets the value format itself. The two you will implement most are:

```go
type Stringer interface {
	String() string
}

type error interface {
	Error() string
}
```

`fmt.Stringer` gives a type a human-readable form for `%v`, `%s` and `Println`. `error` is
the same idea for failures, and also has priority over `String`. A third,
`fmt.Formatter`, hands the type full control of every verb. Knowing the order `fmt`
checks them in, and which receiver it can see, explains every "why did it print that?"
moment.

```go title="main.go"
package main

import "fmt"

type Status int

const (
	Pending Status = iota
	OK
	Broken
)

func (s Status) String() string {
	switch s {
	case Pending:
		return "pending"
	case OK:
		return "ok"
	case Broken:
		return "broken"
	}
	return fmt.Sprintf("Status(%d)", int(s))
}

// Link has a String method on the pointer receiver.
type Link struct {
	URL    string
	Status Status
}

func (l *Link) String() string {
	return l.URL + " [" + l.Status.String() + "]"
}

type result struct {
	Exported Status
	hidden   Status
}

func main() {
	s := Broken
	fmt.Println(s)
	fmt.Printf("%%v=%v  %%s=%s  %%q=%q  %%d=%d  %%#v=%#v  %%x=%x\n", s, s, s, s, s, s)
	fmt.Println(Status(7))

	l := Link{URL: "https://go.dev/missing", Status: Broken}
	fmt.Println("value:  ", l)
	fmt.Println("pointer:", &l)

	fmt.Printf("%v\n", []Status{Pending, OK, Broken})
	fmt.Printf("%+v\n", result{Exported: OK, hidden: OK})
}
```

```bash
go run .
```

```text
broken
%v=broken  %s=broken  %q="broken"  %d=2  %#v=2  %x=62726f6b656e
Status(7)
value:   {https://go.dev/missing broken}
pointer: https://go.dev/missing [broken]
[pending ok broken]
{Exported:ok hidden:1}
```

## How it works

For each operand, except under `%T` and `%p`, `fmt` applies these rules in order (from
the `fmt` package documentation):

1. If the operand implements `fmt.Formatter`, its `Format` method does all the work.
2. For `%#v`, if it implements `fmt.GoStringer`, `GoString` is used.
3. If the verb is valid for a string (`%s %q %x %X`) or is `%v` (but not `%#v`):
   1. if it implements `error`, `Error()` is used;
   2. otherwise, if it implements `fmt.Stringer`, `String()` is used.

The string that method returns is then formatted by the verb. Reading the output with
those rules:

- `%v`, `%s` and `Println` call `String`. `%q` quotes its result and `%x` hex-encodes it
  (`62726f6b656e` is "broken" in hex). `%d` is not a string verb, so it prints the integer,
  and `%#v` without `GoString` prints Go syntax for the underlying value, `2`.
- `Status(7)` falls through the `switch`, so `String` returns `Status(7)`. Always give
  enum-like types a fallback: an unknown value should print something you can debug, not
  an empty string.
- `Link`'s `String` has a pointer receiver. A `Link` *value* does not have it in its method
  set ([[method-sets]]), so `fmt` sees no `Stringer` and prints the struct's fields, while
  `&l` uses `String`. The `Status` field inside still printed as `broken`, because `fmt`
  formats fields recursively and `Status` has a value-receiver `String`.
- Slices and structs are formatted element by element, so `[]Status` prints names.
- `hidden` printed `1`: `fmt` cannot call methods on unexported fields (it reads them via
  reflection, which cannot call their methods), so it prints the raw value.

## error, Stringer and Formatter together

When a type has both `Error` and `String`, `Error` wins. `fmt.Formatter` overrides both and
is how a type offers several renderings, such as a short `%v` and a detailed `%+v`:

```go title="main.go"
package main

import (
	"fmt"
	"io"
)

// LinkError implements error, fmt.Stringer and fmt.Formatter.
type LinkError struct {
	URL    string
	Status int
	Page   string
}

func (e *LinkError) Error() string {
	return fmt.Sprintf("%s: status %d", e.URL, e.Status)
}

func (e *LinkError) String() string {
	return "LinkError(" + e.URL + ")"
}

// Format gives %+v a detailed, multi-field form and leaves other verbs to Error.
func (e *LinkError) Format(f fmt.State, verb rune) {
	switch {
	case verb == 'v' && f.Flag('+'):
		fmt.Fprintf(f, "%s: status %d (linked from %s)", e.URL, e.Status, e.Page)
	case verb == 'v' || verb == 's':
		io.WriteString(f, e.Error())
	case verb == 'q':
		fmt.Fprintf(f, "%q", e.Error())
	default:
		fmt.Fprintf(f, "%%!%c(*main.LinkError)", verb)
	}
}

// both has Error and String; fmt prefers Error.
type both struct{}

func (both) Error() string  { return "from Error" }
func (both) String() string { return "from String" }

func main() {
	fmt.Println(both{})

	err := &LinkError{URL: "https://go.dev/nope", Status: 404, Page: "https://go.dev/"}
	fmt.Println(err)
	fmt.Printf("%v\n", err)
	fmt.Printf("%+v\n", err)
	fmt.Printf("%q\n", err)
	fmt.Printf("%d\n", err)
	fmt.Printf("%T\n", err)
}
```

```text
from Error
https://go.dev/nope: status 404
https://go.dev/nope: status 404
https://go.dev/nope: status 404 (linked from https://go.dev/)
"https://go.dev/nope: status 404"
%!d(*main.LinkError)
*main.LinkError
```

`LinkError.String` is never called: `Format` comes first and handles every verb itself.
`fmt.State` is an `io.Writer` (plus flag, width and precision queries), so `Format` writes
straight into the output. Because `Format` takes over every verb, it must handle the ones
it does not support; this one mimics `fmt`'s own `%!d(...)` notation. `%T` bypasses all the
interfaces. Implement `Formatter` only when you need several forms; `String` or `Error`
covers most types.

## The recursion trap

A `String` method that formats its own receiver with `%v` or `%s` calls itself:

```go title="main.go"
package main

import "fmt"

type Celsius float64

func (c Celsius) String() string {
	return fmt.Sprintf("%v°C", c) // %v calls String again
}

func main() {
	fmt.Println(Celsius(21.5))
}
```

```bash
go vet .
```

```text
main.go:8:22: fmt.Sprintf format %v with arg c causes recursive (example.com/recurse.Celsius).String method call
```

Running it instead ends in `fatal error: stack overflow` after the goroutine's stack
reaches its 1 GB limit. A fatal error is not a panic and cannot be recovered. The fix is
to convert the receiver to a type without the method, here its underlying type:

```go
func (c Celsius) String() string {
	return fmt.Sprintf("%v°C", float64(c)) // float64 has no String method
}
```

which prints `21.5°C`.

> [!WARNING]
> Two mistakes show up again and again. A `String` method on a pointer receiver, then
> printing a value: symptom, `fmt` prints raw struct fields instead of your format; fix,
> use a value receiver for `String` (it only reads), or print a pointer. And a `String`
> or `Error` method that passes its own receiver to `%v`, `%s` or `Sprint`: symptom, a
> stack overflow; fix, convert to the underlying type or format the fields individually.
> `go vet` (which `go test` runs automatically) catches the second one.

> [!NOTE]
> `fmt` recovers a panic raised inside `String`, `Error` or `Format` and prints it as
> `%!v(PANIC=String method: ...)`. A nil pointer receiver is special-cased and prints
> `<nil>`, the behaviour you saw in [[interface-values]]. The verbs themselves are
> covered in [[fmt-verbs]].

linkcheck's `LinkError` gets an `Error` method in exactly this shape in [[step-2-crawl]].
