---
title: Constants, untyped constants and iota
---
A **constant** is a value the compiler knows at compile time: a number, a string, a rune or
a boolean. Go constants behave differently from variables in one important way: most of
them have **no type** until they are used. That is why `3 * time.Second` compiles but
`n * time.Second` with an `int` variable does not, and why `1 << 100` is a perfectly good
constant even though no Go integer type can hold it. `iota` builds on constants to give Go
its enumerations.

## Untyped constants and iota in one program

```go title="main.go"
package main

import (
	"fmt"
	"time"
)

const big = 1 << 100 // an untyped constant: no Go type can hold it

const timeout = 3         // untyped integer constant
const typed int32 = 3     // typed constant
const ratio = timeout / 2 // integer division: 1
const half = 3.0 / 2      // untyped float: 1.5

type Level int

const (
	Debug Level = iota // 0
	Info               // 1
	Warn               // 2
	Error              // 3
)

const (
	_  = iota             // skip 0
	KB = 1 << (10 * iota) // 1 << 10
	MB                    // 1 << 20
	GB                    // 1 << 30
)

type Flag uint8

const (
	FollowRedirects Flag = 1 << iota // 1
	CheckExternal                    // 2
	Verbose                          // 4
)

func main() {
	fmt.Println(big >> 98)
	fmt.Println(time.Duration(timeout) * time.Second)
	fmt.Println(timeout * time.Second) // untyped 3 becomes a time.Duration
	var f float64 = timeout            // untyped int constant fits a float64
	fmt.Println(f, ratio, half)
	fmt.Printf("%T %T %T\n", timeout, half, 'x')
	fmt.Println(Debug, Info, Warn, Error)
	fmt.Println(KB, MB, GB)
	flags := FollowRedirects | Verbose
	fmt.Println(flags, flags&CheckExternal != 0, flags&Verbose != 0)
	_ = typed
}
```

```bash
go run .
```

```text
4
3s
3s
3 1 1.5
int float64 int32
0 1 2 3
1024 1048576 1073741824
5 false true
```

## How it works: untyped constants

A constant declared without a type, like `const timeout = 3`, is an **untyped constant**.
It has a **kind** (integer, floating-point, rune, complex, string or boolean) and an exact
value, but no Go type yet. The rules:

1. **Exact arithmetic.** Constant expressions are evaluated by the compiler with at least
   256 bits of precision, not in machine integers. `1 << 100` is fine; `big >> 98` is
   exactly 4. Nothing overflows until the value has to fit a real type.
2. **The type comes from the context.** When an untyped constant meets a typed operand or is
   assigned to a typed variable, it takes that type, if its value fits. `timeout *
   time.Second` makes `3` a `time.Duration`; `var f float64 = timeout` makes it a
   `float64`.
3. **A default type when there is no context.** In `x := timeout` or when passed as `any`
   (as to `Printf`), an untyped constant gets its kind's default type: integer to `int`,
   floating-point to `float64`, rune to `rune` (an alias for `int32`, hence `int32` in the
   output for `'x'`), complex to `complex128`, string to `string`, boolean to `bool`.
4. **Kind follows the operands.** `timeout / 2` is integer division (both are integer
   constants), giving `1`. `3.0 / 2` is floating-point, giving `1.5`.

A **typed** constant, `const typed int32 = 3`, behaves like a value of that type: it does
not adapt to context. The mistakes this rule catches, with the compiler's words:

```go title="e/e.go"
package e

import "time"

const big = 1 << 100
const typed int32 = 3

func errors() {
	var n int = big
	var d time.Duration = typed
	secs := 3
	wait := secs * time.Second
	var b byte = 256
	_, _, _, _ = n, d, wait, b
}
```

```text
# example.com/consts/e
e\e.go:9:14: cannot use big (untyped int constant 1267650600228229401496703205376) as int value in variable declaration (overflows)
e\e.go:10:24: cannot use typed (constant 3 of type int32) as time.Duration value in variable declaration
e\e.go:12:10: invalid operation: secs * time.Second (mismatched types int and time.Duration)
e\e.go:13:15: cannot use 256 (untyped int constant) as byte value in variable declaration (overflows)
```

The third line is the one you will meet most. `secs` is a variable of type `int`, and Go
never converts between types implicitly, so multiply a converted value instead:
`time.Duration(secs) * time.Second`. Leaving constants untyped is what makes them
pleasant to use; give a constant a type only when you want that type enforced, as with the
enumerations below.

## How it works: iota

Inside a `const ( ... )` block, `iota` is the index of the current line (the
**ConstSpec**), starting at 0 and reset to 0 in every new block. A line that omits its
expression repeats the previous line's type and expression, with the new `iota`. That
gives three patterns:

| Pattern | Lines | Values |
|---|---|---|
| Enumeration | `Debug Level = iota`, then bare names | 0, 1, 2, 3 |
| Skip a value | `_ = iota` first | Starts the named values at 1 |
| Bit flags | `FollowRedirects Flag = 1 << iota` | 1, 2, 4, 8: combine with bitwise OR, test with `&` |
| Scaled | `KB = 1 << (10 * iota)` after `_` | 1024, 1048576, 1073741824 |

Giving the enumeration its own defined type (`type Level int`) is what makes it more than a
list of numbers: a function that takes a `Level` will not accept a `Flag` by mistake. Types
like this are the subject of [[defined-types]], and printing a `Level` as `WARN` instead of
`2` is a `String` method, shown in [[stringer-fmt]].

## The zero-value trap with iota

An enumeration that starts at `iota` makes its first name the zero value. Combine that with
[[zero-values]] and an unset field silently means the first constant:

```go title="main.go"
package main

import "fmt"

type Status int

const (
	StatusOK Status = iota
	StatusBroken
	StatusSkipped
)

type Check struct {
	URL    string
	Status Status
}

func main() {
	var c Check // never checked
	c.URL = "https://example.com/missing"
	if c.Status == StatusOK {
		fmt.Println(c.URL, "is fine")
	}
}
```

```text
https://example.com/missing is fine
```

Reserve the zero value for "unknown":

```go title="main.go"
package main

import "fmt"

type Status int

const (
	StatusUnknown Status = iota // the zero value means "not checked yet"
	StatusOK
	StatusBroken
	StatusSkipped
)

type Check struct {
	URL    string
	Status Status
}

func main() {
	var c Check
	c.URL = "https://example.com/missing"
	switch c.Status {
	case StatusOK:
		fmt.Println(c.URL, "is fine")
	case StatusUnknown:
		fmt.Println(c.URL, "was never checked")
	}
}
```

```text
https://example.com/missing was never checked
```

> [!WARNING]
> When the first constant of an `iota` enumeration is a real state, every value nobody set
> reads as that state: a link nobody checked reports "OK", and nothing fails. Start the
> block with an `Unknown` (or `_ = iota` to skip 0) unless the zero value genuinely is the
> right default, like `Debug` as the most verbose level or "no flags set". Decide on
> purpose.

> [!NOTE]
> Constants can only be numbers, strings, runes and booleans. There are no constant
> structs, slices or maps; for a fixed table, use a package-level `var`. `time.Second` is a
> typed constant (of type `time.Duration`), which is why it only multiplies with untyped
> constants and other `Duration` values.
