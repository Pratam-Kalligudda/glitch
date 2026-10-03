---
title: Declarations and zero values
---
In Go every variable holds a valid value from the moment it exists. There is no
"uninitialised" state and no `undefined`: a variable you declare without a value gets its
type's **zero value**. This one rule removes a whole class of bugs, and it shapes how
idiomatic Go types are designed: a good type is usable as soon as it is declared, with no
constructor call.

## Every zero value

```go title="main.go"
package main

import (
	"bytes"
	"fmt"
	"strings"
	"sync"
)

type Result struct {
	URL    string
	Status int
	OK     bool
	Tags   []string
	Meta   map[string]string
	Next   *Result
}

func main() {
	var (
		i  int
		f  float64
		s  string
		b  bool
		p  *int
		sl []int
		m  map[string]int
		ch chan int
		fn func()
		e  error
		a  [3]int
		r  Result
	)
	fmt.Printf("%v %v %q %v %v %v %v %v %v %v %v\n", i, f, s, b, p, sl, m, ch, fn == nil, e, a)
	fmt.Printf("%+v\n", r)
	fmt.Println(sl == nil, len(sl), m == nil, len(m), m["missing"])

	sl = append(sl, 1) // append to a nil slice works
	fmt.Println(sl)

	var buf bytes.Buffer // ready to use
	buf.WriteString("hello")
	var sb strings.Builder
	sb.WriteString(" world")
	var mu sync.Mutex
	mu.Lock()
	fmt.Println(buf.String() + sb.String())
	mu.Unlock()
}
```

```bash
go run .
```

```text
0 0 "" false <nil> [] map[] <nil> true <nil> [0 0 0]
{URL: Status:0 OK:false Tags:[] Meta:map[] Next:<nil>}
true 0 true 0 0
[1]
hello world
```

## How it works

The zero value is "all bits zero", interpreted by the type:

| Type | Zero value | Usable as is? |
|---|---|---|
| Numbers | `0` | Yes |
| `string` | `""` | Yes |
| `bool` | `false` | Yes |
| Array `[N]T` | N zero values of `T` | Yes |
| Struct | Every field at its zero value | Yes, if the type was designed for it |
| Pointer, function | `nil` | Calling or dereferencing panics |
| Slice | `nil`: length 0, capacity 0 | Read, `len`, `range` and `append` all work |
| Map | `nil`: length 0 | Reading works and returns the element's zero value; **writing panics** |
| Channel | `nil` | Sending and receiving block forever (see [[channels]]) |
| Interface (`error`, `any`) | `nil` | Calling a method panics |

Zero-initialisation is not a convention; the language guarantees it for every variable,
every struct field, every array element and every element of a new slice made with `make`.
Memory the runtime hands out is always zeroed first, so there is no garbage value to read.

Composite types are zeroed recursively: a `Result` has a `nil` slice and map inside it, not
empty ones. Printing hides the difference (`Tags:[]`, `Meta:map[]`), but `sl == nil` and
`m == nil` are both `true`. The distinction matters when you write to a map, and later when
you encode JSON (see [[json]]).

**Useful zero values by design.** `bytes.Buffer`, `strings.Builder` and `sync.Mutex` work
without any setup: an empty buffer, an empty builder, an unlocked mutex. Their authors
chose fields whose zero values mean "empty" or "unlocked". Do the same in your own types:
prefer a `nil` slice that methods `append` to over a field that must be `make`d first, and
name `bool` fields so that `false` is the sensible default. A `bool` cannot default to
`true`, so a config with `Verbose bool` works when left empty, while one with `Quiet bool`
that should normally be on does not.

## Declaration forms

| Form | Where | Notes |
|---|---|---|
| `var x int` | Anywhere | Zero value |
| `var x = 10` / `var x int = 10` | Anywhere | Type inferred, or stated |
| `x := 10` | Inside functions only | Short variable declaration; type inferred |
| `var ( ... )` | Anywhere | Groups declarations |

Use `var x T` when you want the zero value on purpose, and `x := value` when you have a
value. Package-level declarations must use `var`.

`:=` declares **at least one new variable** on its left and assigns to the others, if they
were declared **in the same scope**:

```go title="redecl.go"
package main

import "strconv"

func redecl() {
	a, err := strconv.Atoi("1")
	b, err := strconv.Atoi("2") // legal: b is new, err is reused
	a, err := strconv.Atoi("3")
	_, _, _ = a, b, err
}
```

```text
.\redecl.go:8:9: no new variables on left side of :=
```

The compiler also rejects a local variable that is declared and never used, so leftovers
from debugging do not linger:

```go title="unused.go"
package main

func unused() {
	x := 1
	var y int
}
```

```text
.\unused.go:4:2: declared and not used: x
.\unused.go:5:6: declared and not used: y
```

Package-level variables, function parameters and unused imports have different rules:
unused package variables and parameters are allowed; unused imports are an error.

## The shadowing trap

"In the same scope" is the part that bites. Each `{ }` block is a new scope, and `:=` in an
inner block declares **new** variables that hide the outer ones:

```go title="main.go"
package main

import (
	"fmt"
	"strconv"
)

func parsePort(s string) (int, error) {
	port := 80
	var err error
	if s != "" {
		port, err := strconv.Atoi(s)
		if err != nil {
			return 0, err
		}
		fmt.Println("parsed", port)
	}
	return port, err
}

func main() {
	p, err := parsePort("8080")
	fmt.Println(p, err)
}
```

```text
parsed 8080
80 <nil>
```

The function parsed 8080 and returned 80. Inside the `if`, `port, err :=` made a second
`port` and a second `err` that disappear at the closing brace. It compiles, `go vet` exits
0, and the inner `port` counts as used because the `Println` reads it.

> [!WARNING]
> A `:=` inside an `if`, `for` or `switch` block that is meant to update an outer variable
> creates a new one instead. The symptom is a value that is "set" but reads back as its old
> value, often an error that is silently `nil` after the block. Use plain `=` when the
> variables already exist: `port, err = strconv.Atoi(s)`. If you need a new variable next
> to an existing one, declare the new one with `var` first, then use `=`.

Writing to a `nil` map is the other zero-value mistake; it panics with
`assignment to entry in nil map`, and [[maps]] shows why and how to avoid it.
