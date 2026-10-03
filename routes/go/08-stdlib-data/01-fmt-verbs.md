---
title: fmt in depth
done_when: "You can pick the right verb, width and flag for a value, read a %!verb(type=value) error on sight, and go vet is clean on your Printf calls."
---
`fmt` formats values into text. You have used `Println` and `Printf("%d")`. This stop covers
the part people guess at: what each verb prints for each kind of value, how width, precision
and flags change it, what the output looks like when you get it wrong, and how `fmt` decides
to call your `String` method.

A **verb** is the `%` plus a letter in a format string: it says how to render one argument.
**Flags**, **width** and **precision** sit between the `%` and the verb: `%-8.2f`.

## The general verbs

These work on any value:

```go title="verbs/main.go"
package main

import "fmt"

type Point struct {
	X, Y int
}

type Link struct {
	URL    string
	Status int
	Tags   []string
	Next   *Link
}

func main() {
	p := Point{3, -4}
	l := Link{"https://go.dev", 200, []string{"docs"}, nil}

	fmt.Printf("%v\n", p)
	fmt.Printf("%+v\n", p)
	fmt.Printf("%#v\n", p)
	fmt.Printf("%T\n", p)
	fmt.Printf("%v\n", l)
	fmt.Printf("%+v\n", l)
	fmt.Printf("%#v\n", l)
	fmt.Printf("%v %v\n", []int{1, 2}, map[string]int{"b": 2, "a": 1})
	fmt.Printf("%#v %#v\n", []int{1, 2}, map[string]int{"b": 2, "a": 1})
	fmt.Printf("%d %b %o %x %X %c %U\n", 255, 255, 255, 255, 255, 'G', 'G')
	fmt.Printf("%q %q\n", "hi\n", 'x')
	fmt.Printf("%s %x % x\n", "go", "go", "go")
	fmt.Printf("%t %p\n", true, nil)
	fmt.Printf("%e %f %g %.2f\n", 1234.5678, 1234.5678, 1234.5678, 1234.5678)
	fmt.Printf("%v %v\n", 1e21, 1e20)
	fmt.Printf("%%\n")
}
```

```bash
go run ./verbs
```

```text
{3 -4}
{X:3 Y:-4}
main.Point{X:3, Y:-4}
main.Point
{https://go.dev 200 [docs] <nil>}
{URL:https://go.dev Status:200 Tags:[docs] Next:<nil>}
main.Link{URL:"https://go.dev", Status:200, Tags:[]string{"docs"}, Next:(*main.Link)(nil)}
[1 2] map[a:1 b:2]
[]int{1, 2} map[string]int{"a":1, "b":2}
255 11111111 377 ff FF G U+0047
"hi\n" 'x'
go 676f 67 6f
true %!p(<nil>)
1.234568e+03 1234.567800 1234.5678 1234.57
1e+21 1e+20
%
```

## How it works

**`%v` is the default format for the value's type.** It prints a struct as `{3 -4}`, a
slice as `[1 2]` and a pointer-to-struct as `&{3 -4}` (only at the top level; nested
pointers print as addresses). `%+v` adds field names, which is what you want in logs.
`%#v` prints Go syntax you could paste into source, including the type: use it when you
need to see exactly what a value is, for example whether a slice is `nil` or empty. `%T`
prints only the type.

**Maps print in sorted key order.** Since Go 1.12 `fmt` sorts map keys, so `map[a:1 b:2]`
is stable between runs. That makes `%v` safe for test output, although ranging over a map
yourself is still random ([[maps]]).

**Integers have one verb per base.** `%d` decimal, `%b` binary, `%o` octal, `%x` and `%X`
hex (lower and upper case letters). `%c` is the character for a code point and `%U` the
`U+0047` form. A negative number prints with the sign, not two's complement: `%x` of `-255`
is `-ff`.

**Strings and bytes.** `%s` is the text; `%q` is a Go-quoted string with escapes, which
makes invisible characters (`\n`, trailing spaces) visible, so prefer it when debugging
strings. `%x` on a string or `[]byte` prints each byte as two hex digits, and the space
flag separates the bytes: `% x`.

**Floats.** `%f` is plain decimal with 6 digits after the point, `%e` is scientific, and
`%g` picks the shorter of the two and uses as few digits as needed to identify the value.
`%v` for a float is `%g`, except the switch to exponent form happens at exponent 21, which
is why `1e20` prints `1e+20` and `100000000000000000000` is what `%f` gives. `%.2f` sets
precision.

## Width, precision and flags

```go title="flags/main.go"
package main

import "fmt"

func main() {
	fmt.Printf("[%5d] [%-5d] [%05d] [%+d]\n", 42, 42, 42, 42)
	fmt.Printf("[%8.3f] [%-8.2f] [%08.2f]\n", 3.14159, 3.14159, 3.14159)
	fmt.Printf("[%10s] [%-10s] [%.3s]\n", "go", "go", "golang")
	fmt.Printf("[%*d] [%-*d]\n", 6, 42, 6, 42)
	fmt.Printf("[%#x] [%#o] [%x]\n", 255, 8, -255)
	fmt.Printf("[%6.2f%%]\n", 93.456)
	fmt.Printf("%[2]d %[1]d %[2]d\n", 1, 2)
	fmt.Printf("%6.2f|%6.2f|%6.2f\n", 1.5, 22.25, 333.125)
	fmt.Printf("%x %X\n", []byte("Go!"), []byte("Go!"))
	fmt.Printf("%08b\n", 5)
}
```

```text
[   42] [42   ] [00042] [+42]
[   3.142] [3.14    ] [00003.14]
[        go] [go        ] [gol]
[    42] [42    ]
[0xff] [010] [-ff]
[ 93.46%]
2 1 2
  1.50| 22.25|333.12
476f21 476F21
00000101
```

| Part | Meaning | Example |
|---|---|---|
| width (`%5d`) | Minimum width; shorter values are padded with spaces on the left | `[   42]` |
| `-` flag | Pad on the right instead (left-align) | `[42   ]` |
| `0` flag | Pad numbers with zeros after the sign | `[00042]` |
| `+` flag | Always print the sign of a number | `[+42]` |
| space flag | A space where the sign would go; with `%x` on strings, separates bytes | `% x` |
| `#` flag | Alternate form: `0x` for hex, leading `0` for octal, Go syntax for `%v` | `[0xff]` |
| precision (`%.2f`) | Digits after the point for floats; maximum characters for strings | `[gol]` |
| `*` | Take the width (or precision) from an argument | `%*d` with `6, 42` |
| `[n]` | Use argument number `n` (1-based) for the next verb | `%[2]d %[1]d` |
| `%%` | A literal percent sign | `[ 93.46%]` |

Width counts runes, not bytes, so `%-10s` aligns text with accents correctly, but it does
not know about double-width characters or combining marks. For aligned tables with many
columns, use `text/tabwriter` from the standard library, or compute widths yourself.

The `333.12` in the output is not a typo: `333.125` has no exact binary representation, and
`fmt` rounds the value the float actually holds. Do not rely on `%.2f` for money; keep
amounts in integer cents.

## When the verb and the value disagree

`Printf` does not fail at compile time and does not panic. It prints what went wrong
inside the output:

```go title="bad/main.go"
package main

import "fmt"

func main() {
	fmt.Printf("%d\n", "text")
	fmt.Printf("%s\n", 42)
	fmt.Printf("%d %d\n", 1)
	fmt.Printf("%d", 1, 2)
	fmt.Println()
	fmt.Printf("%z\n", 1)
}
```

```text
%!d(string=text)
%!s(int=42)
1 %!d(MISSING)
1%!(EXTRA int=2)
%!z(int=1)
```

| Output | Cause |
|---|---|
| `%!d(string=text)` | Wrong type for the verb: verb `d`, the value was a `string` with value `text` |
| `%!d(MISSING)` | More verbs than arguments |
| `%!(EXTRA int=2)` | More arguments than verbs |
| `%!z(int=1)` | Unknown verb |
| `%!v(PANIC=String method: ...)` | The value's `String` method panicked |

`go vet` finds all of these statically, and `go test` runs the same check automatically
(the `printf` analyzer, see [[vet-fmt-fix]]):

```text
bad\main.go:6:14: fmt.Printf format %d has arg "text" of wrong type string
bad\main.go:7:14: fmt.Printf format %s has arg 42 of wrong type int
bad\main.go:8:17: fmt.Printf format %d reads arg #2, but call has 1 arg
bad\main.go:9:2: fmt.Printf call needs 1 arg but has 2 args
bad\main.go:11:14: fmt.Printf format %z has unknown verb z
```

> [!WARNING]
> A `%!d(string=...)` in a log line is a bug that ships, because nothing stops the
> program. Symptom: garbage like `%!s(MISSING)` in production logs or error messages.
> Fix: run `go vet ./...` in CI. The analyzer also follows your own wrapper functions
> (`func logf(format string, args ...any)`) when they forward to `fmt.Sprintf`, so name
> them like `Printf` wrappers, ending in `f`.

## The Print family

| Function | Writes to | Newline | Spaces between operands |
|---|---|---|---|
| `Print`, `Printf`, `Println` | `os.Stdout` | `Println` adds one | `Print`: only between operands when neither is a string. `Println`: always |
| `Sprint`, `Sprintf`, `Sprintln` | returns a `string` | `Sprintln` adds one | same rules |
| `Fprint`, `Fprintf`, `Fprintln` | an `io.Writer` | `Fprintln` adds one | same rules |
| `Append`, `Appendf`, `Appendln` | appends to a `[]byte`, returns it | `Appendln` adds one | same rules |
| `Errorf` | returns an `error` | no | verb `%w` wraps an error ([[wrapping]]) |

The `Fprint` family is the one to prefer in library code: it takes any `io.Writer`
([[io-composition]]), so it prints to a file, a buffer, an HTTP response or `os.Stderr`
equally. `Append*` avoids an allocation when you build a byte slice.

```go title="scan/main.go"
package main

import (
	"errors"
	"fmt"
	"os"
)

type Status int

func (s Status) String() string { return fmt.Sprintf("Status(%d)", int(s)) }

func main() {
	var name string
	var n int
	c, err := fmt.Sscanf("go 42", "%s %d", &name, &n)
	fmt.Println(c, err, name, n)
	c, err = fmt.Sscan("7 8", &n)
	fmt.Println(c, err, n)

	s := fmt.Sprint("a", 1, 2, "b", "c", 3.5)
	fmt.Printf("%q\n", s)
	fmt.Printf("%q\n", fmt.Sprintln("a", 1))

	fmt.Fprintln(os.Stderr, "to stderr")
	b := fmt.Appendf(nil, "n=%d", 5)
	fmt.Println(string(b))

	var st Status = 3
	fmt.Printf("%v %d %s\n", st, st, st)
	e := fmt.Errorf("open: %w", errors.New("boom"))
	fmt.Println(e)
	fmt.Println(fmt.Sprintf("%v", nil), fmt.Sprintf("%d", []int(nil)))
}
```

```text
2 <nil> go 42
1 <nil> 7
"a1 2bc3.5"
"a 1\n"
to stderr
n=5
Status(3) 3 Status(3)
open: boom
<nil> []
```

`Sprint("a", 1, 2, "b", "c", 3.5)` gives `a1 2bc3.5`: `Sprint` inserts a space only between
two operands that are both non-strings (`1 2`). `Sprintln` always inserts spaces and
appends a newline.

`Sscanf` and `Sscan` are the reading counterparts: they parse text into variables and
return the number of items read and an error. They are fine for a quick parse of a known
shape. For anything user-facing, read lines with `bufio` ([[bufio]]) and convert with
`strconv` ([[strconv]]), which give precise errors.

## How fmt picks a representation

For `%v` and `%s`, `fmt` checks the argument in this order:

1. If the operand implements `fmt.Formatter` (a `Format(f fmt.State, verb rune)` method),
   that method does everything.
2. For `%#v`, if it implements `fmt.GoStringer`, `GoString()` is used.
3. For verbs valid for strings (`%s %q %v %x %X`): if it implements `error`, `Error()` is
   used; otherwise if it implements `fmt.Stringer`, `String()` is used.
4. Otherwise `fmt` uses reflection to print the value by its kind.

Numeric verbs such as `%d` skip steps 3 and 4's methods, which is why `Status(3)` prints as
`3` with `%d` and as `Status(3)` with `%v` and `%s`. Interfaces and the full
Stringer story are in [[stringer-fmt]].

> [!WARNING]
> Calling `Sprintf("%v", x)` inside `x.String()` recurses forever when `x`'s type is the
> receiver: `%v` calls `String` again. Symptom: a stack overflow
> (`goroutine stack exceeds 1000000000-byte limit`). Fix: convert to a type without the
> method first, for example `fmt.Sprintf("%d", int(s))` for an integer type, or
> `type plain Status` and `fmt.Sprintf("%d", plain(s))`.

> [!NOTE]
> `fmt` calls `Error` and `String` only on values it can reach through exported fields.
> In a struct with an exported `Err error` and an unexported `err error`, `%v` prints the
> message for `Err` but a raw pointer such as `0xc000012345` for `err`; likewise an
> unexported `time.Duration` field prints `1000000000` while an exported one prints `1s`.
> Export the field, or print it explicitly, when you want the readable form.

linkcheck prints its text report with `Fprintf` to any `io.Writer` in
[[step-7-reporters]].
