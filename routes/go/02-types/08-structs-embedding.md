---
title: Structs, tags and embedding
---
A **struct** groups named fields into one value. Go has no classes and no inheritance;
structs plus methods are how you model data, and **embedding**, putting a type inside a
struct without a field name, is how you reuse another type's fields and methods. Structs
also carry **tags**, string metadata on each field that encoders such as `encoding/json`
read at run time. This stop covers all three, and the rules that decide which field
`r.URL` actually means.

## A result built from smaller pieces

```go title="main.go"
package main

import (
	"fmt"
	"reflect"
	"sync"
	"time"
)

// Target is a page to check.
type Target struct {
	URL   string `json:"url" csv:"url"`
	Depth int    `json:"depth,omitempty"`
}

// Timing records when a check ran.
type Timing struct {
	Start, End time.Time
}

func (t Timing) Elapsed() time.Duration { return t.End.Sub(t.Start) }

// Result embeds Target and Timing: their fields and methods are promoted.
type Result struct {
	Target
	Timing
	Status int
	mu     sync.Mutex
}

func (r *Result) SetStatus(code int) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.Status = code
}

func main() {
	start := time.Date(2026, 10, 3, 9, 0, 0, 0, time.UTC)
	r := &Result{
		Target: Target{URL: "https://go.dev", Depth: 1},
		Timing: Timing{Start: start, End: start.Add(120 * time.Millisecond)},
	}
	r.SetStatus(200)

	fmt.Println(r.URL, r.Target.URL, r.Depth, r.Status, r.Elapsed())

	a := Target{"https://go.dev", 0} // positional literal: every field, in order
	b := Target{URL: "https://go.dev"}
	fmt.Println(a == b)

	field, _ := reflect.TypeFor[Target]().FieldByName("Depth")
	fmt.Println(field.Tag.Get("json"), field.Tag.Get("csv") == "")

	point := struct{ X, Y int }{1, 2} // anonymous struct
	fmt.Printf("%+v\n", point)
}
```

```bash
go run .
```

```text
https://go.dev https://go.dev 1 200 120ms
true
depth,omitempty true
{X:1 Y:2}
```

## How it works: literals and comparison

A **keyed literal**, `Target{URL: "https://go.dev"}`, sets the fields you name and leaves
the rest at their zero values. A **positional literal**, `Target{"https://go.dev", 0}`, must
list every field in declaration order. Use keyed literals for any type you do not control:
adding a field to a struct breaks every positional literal of it, and `go vet` warns about
positional literals of types from other packages for that reason.

Two struct values are **comparable** with `==` when all their fields are comparable; they
are equal when every field is equal, which is why `a == b`. A struct with a slice, map or
function field cannot be compared, and the compiler says so (see the errors below). Only
comparable structs can be map keys ([[maps]]).

An **anonymous struct**, `struct{ X, Y int }{1, 2}`, is a type literal used once: handy for
table-driven tests ([[table-tests]]) and one-off JSON shapes.

## How it works: tags

A **tag** is the raw string after a field's type. By convention it is a space-separated
list of `key:"value"` pairs. The compiler ignores tags; libraries read them through the
`reflect` package, as `Tag.Get("json")` did. `encoding/json` reads `json:"url"` to name the
field `url` in JSON and `omitempty` to drop it when it is zero; the details are in
[[json]]. A tag that does not follow the convention, such as `json:url` without quotes,
is silently useless; `go vet`'s `structtag` check catches it.

## How it works: embedding and promotion

A field declared with a type but no name, like `Target` inside `Result`, is an **embedded
field**. Its name is the type name, so `r.Target` still works. Its fields and methods are
**promoted**: `r.URL` means `r.Target.URL` and `r.Elapsed()` means `r.Timing.Elapsed()`.

Embedding is not inheritance. A `Result` is not a `Target`; you cannot pass a `Result`
where a `Target` is expected. When `r.Elapsed()` runs, its receiver is `r.Timing`, and
`Timing` knows nothing about the `Result` around it. Embedding is composition with
automatic forwarding.

Which field a selector like `x.URL` names is decided by **depth**: a field declared directly
in the struct is at depth 0, fields of an embedded struct at depth 1, and so on. The
shallowest one wins. Two at the same shallowest depth are an error, but only if you use
the name:

```go title="e/e.go"
package e

type Target struct{ URL string }
type Redirect struct{ URL string }

type Hop struct {
	Target
	Redirect
}

type Page struct {
	URL   string
	Links []string
}

func errors() {
	var h Hop
	_ = h.URL
	_ = Page{} == Page{}
}
```

```text
# example.com/structs/e
e\e.go:18:8: ambiguous selector h.URL
e\e.go:19:6: invalid operation: Page{} == Page{} (struct containing []string cannot be compared)
```

Write `h.Target.URL` or `h.Redirect.URL` to choose.

Depth also lets an outer field **shadow** an embedded one, and embedding a pointer type
promotes through the pointer:

```go title="shadow/main.go"
package main

import (
	"fmt"
	"sync"
)

type Target struct {
	URL string
}

func (t Target) String() string { return "target " + t.URL }

// Redirect has its own URL field, which hides Target.URL.
type Redirect struct {
	*Target
	URL string
}

// Counter embeds sync.Mutex: Lock and Unlock become part of its API.
type Counter struct {
	sync.Mutex
	N int
}

func main() {
	r := Redirect{Target: &Target{URL: "http://go.dev"}, URL: "https://go.dev"}
	fmt.Println(r.URL, r.Target.URL, r.String())

	var c Counter
	c.Lock() // any caller can do this
	c.N++
	c.Unlock()
	fmt.Println(c.N)

	var empty Redirect
	fmt.Println(empty.URL == "")
	fmt.Println(empty.String())
}
```

```text
https://go.dev http://go.dev target http://go.dev
1
true
panic: runtime error: invalid memory address or nil pointer dereference
[signal 0xc0000005 code=0x0 addr=0x0 pc=0x7ff6c28c53ef]
```

`r.URL` is the outer field at depth 0; `r.String()` is promoted from `*Target` and sees
`Target`'s URL. `empty.String()` panics because the embedded `*Target` is `nil`, and the
promoted call dereferences it. (The `signal` line is the Windows form; Linux and macOS print
`SIGSEGV`.)

## Struct literal keys for promoted fields (Go 1.27)

Until Go 1.26, a literal had to spell out the embedded struct:
`Result{Target: Target{URL: ...}}`. Since Go 1.27, a key may be any field selector for the
struct, including promoted fields:

```go title="lit/main.go"
package main

import "fmt"

type Target struct {
	URL   string
	Depth int
}

type Result struct {
	Target
	Status int
}

func main() {
	// Go 1.27: a key may be any field selector, including promoted fields.
	r := Result{URL: "https://go.dev", Depth: 2, Status: 200}
	fmt.Printf("%+v\n", r)
}
```

```text
{Target:{URL:https://go.dev Depth:2} Status:200}
```

The feature follows the module's language version from [[toolchain]]. With `go 1.26` in
go.mod, the same file fails:

```text
# example.com/structs/lit
lit\main.go:17:14: use of promoted field Target.URL in struct literal of type Result requires go1.27 or later (-lang was set to go1.26; check go.mod)
lit\main.go:17:37: use of promoted field Target.Depth in struct literal of type Result requires go1.27 or later (-lang was set to go1.26; check go.mod)
```

## Field order and size

Fields are laid out in declaration order, each aligned to its size, so the compiler may
insert padding. `struct{ OK bool; Status int64; Redir bool }` is 24 bytes on 64-bit
platforms; the same fields ordered `Status, OK, Redir` take 16 (`unsafe.Sizeof` reports
both). Reorder only for types you hold millions of; readability comes first otherwise.

> [!WARNING]
> Embedding a type exports its whole method set as part of yours. `Counter` above embeds
> `sync.Mutex`, so every caller can call `c.Lock()` and `c.Unlock()`, and can deadlock your
> type from outside. The symptom is a lock you cannot reason about locally. Use a named,
> unexported field (`mu sync.Mutex`, as `Result` does) for anything that is an
> implementation detail, and embed only when you want the embedded type's API to be your
> type's API. The same applies to embedding a pointer: a `nil` embedded pointer turns
> every promoted method into a nil dereference.

> [!NOTE]
> Embedding interfaces in interfaces, and interfaces in structs, follow the same promotion
> rules and are covered in [[embedding-interfaces]]. How promotion interacts with pointer
> receivers is in [[method-sets]].

linkcheck's JSON and XML reporters in [[step-7-reporters]] name their output fields with
struct tags.
