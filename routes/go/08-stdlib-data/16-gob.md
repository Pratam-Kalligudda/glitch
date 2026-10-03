---
title: encoding/gob
---
`gob` is Go's own binary format for Go values. You hand an encoder a value and it writes a
compact stream; a decoder in another Go program reads it back into a value of a compatible
type. There is no schema file and no tags: the stream describes its types as it goes. `gob`
is meant for Go-to-Go communication: caching, saving state between runs, and the Go `net/rpc`
package. It is **not** a format for other languages, for long-term archives, or for untrusted
data. Use [[json]] when anything outside Go must read it.

## Encode and decode

```go title="a/main.go"
package main

import (
	"bytes"
	"encoding/gob"
	"encoding/json"
	"fmt"
	"log"
)

type Page struct {
	URL    string
	Status int
	Links  []string
	Meta   map[string]string
	hidden int // unexported: ignored
}

func main() {
	in := Page{URL: "https://go.dev/", Status: 200, Links: []string{"/doc", "/blog"}, Meta: map[string]string{"lang": "en"}, hidden: 1}

	var buf bytes.Buffer
	if err := gob.NewEncoder(&buf).Encode(in); err != nil {
		log.Fatal(err)
	}
	fmt.Println("gob bytes:", buf.Len())
	j, _ := json.Marshal(in)
	fmt.Println("json bytes:", len(j))

	var out Page
	if err := gob.NewDecoder(&buf).Decode(&out); err != nil {
		log.Fatal(err)
	}
	fmt.Printf("%+v\n", out)
}
```

```bash
go run ./a
```

```text
gob bytes: 163
json bytes: 84
{URL:https://go.dev/ Status:200 Links:[/doc /blog] Meta:map[lang:en] hidden:0}
```

How it works:

- `gob.NewEncoder(w).Encode(v)` writes `v` to any `io.Writer`; `gob.NewDecoder(r).Decode(&v)`
  reads into a pointer. Both work on streams ([[io-composition]]), so the same code writes to a
  file, a socket, a `bytes.Buffer`, or through gzip ([[compress]]).
- **Only exported fields** are sent. `hidden` came back as `0`. A struct without any exported
  field fails: `gob: type struct { x int } has no exported fields`.
- **Types are described on the wire**, so the first value of a type includes a description of it.
  That is why 163 gob bytes were larger than the 84 JSON bytes for this single small value; the
  cost is paid once per type per stream, not per value (see the stream example below), so gob
  wins when there are many values.
- Supported: booleans, integers, floats, complex numbers, strings, byte slices, slices and arrays,
  maps, structs, pointers and interface values. Channels and functions cannot be sent.

## Compatibility between versions

The encoder and decoder do not need the same Go type, only compatible ones. Fields are matched by
**name**, not by position, so a program can add or remove fields and still read old data:

```go title="b/main.go"
package main

import (
	"bytes"
	"encoding/gob"
	"fmt"
)

type V1 struct {
	Name  string
	Count int
	Old   string
}

type V2 struct {
	Name  string
	Count int64 // int to int64 is allowed: both are signed integers
	New   bool  // not in V1
}

type Bad struct {
	Name []string // string to []string is not
}

func roundTrip(in, out any) error {
	var buf bytes.Buffer
	if err := gob.NewEncoder(&buf).Encode(in); err != nil {
		return err
	}
	return gob.NewDecoder(&buf).Decode(out)
}

func main() {
	var v2 V2
	err := roundTrip(V1{"a", 7, "dropped"}, &v2)
	fmt.Printf("%+v %v\n", v2, err)

	var bad Bad
	err = roundTrip(V1{"a", 7, ""}, &bad)
	fmt.Println(err)

	var none struct{ Other int }
	err = roundTrip(V1{"a", 7, ""}, &none)
	fmt.Println(err)

	// Zero values are not transmitted, so the decoder cannot tell "zero" from "absent".
	type Z struct {
		N int
		P *int
		S []int
		M map[string]int
	}
	zero := 0
	var z Z
	z.P = &zero
	z.S = []int{}
	z.M = map[string]int{}
	z2 := Z{N: 5, M: map[string]int{"x": 1}}
	err = roundTrip(z, &z2)
	fmt.Println("N is still", z2.N, err)
	fmt.Println("P nil:", z2.P == nil, "S nil:", z2.S == nil, "len(M):", len(z2.M))

	if err := gob.NewEncoder(&bytes.Buffer{}).Encode(struct{ x int }{1}); err != nil {
		fmt.Println(err)
	}
}
```

```text
{Name:a Count:7 New:false} <nil>
gob: wrong type ([]string) for received field V1.Name
gob: type mismatch: no fields matched compiling decoder for 
N is still 5 <nil>
P nil: true S nil: true len(M): 1
gob: type struct { x int } has no exported fields
```

Rules from that output:

- A field in the stream with no counterpart in the target is **ignored** (`Old`). A field in the
  target that the stream lacks is **left unchanged** (`New` stays `false`).
- Compatible kinds convert: an `int` in the stream can land in an `int64` field, since both are
  signed integers. A `string` into a `[]string` fails: `gob: wrong type ([]string) for received
  field V1.Name`.
- If **no** field matches, decoding fails with `gob: type mismatch: no fields matched`.
- **Zero values are not transmitted.** A field that is `0`, `""`, `false`, a nil or empty slice or
  map, or a pointer to a zero value, is left out of the stream. The decoder therefore keeps
  whatever was already in the target: `N` stayed `5`, although the sender's `N` was `0`. A pointer
  to zero came back `nil`, and an empty slice came back `nil`.

> [!WARNING]
> Decoding into a variable that already holds data merges instead of replacing, because zero
> values are not sent. Symptom: a value that "remembers" fields from a previous message, or
> a field that cannot be reset to zero by a round trip. Fix: decode into a **fresh** value
> (`var v T`) each time, and do not use `nil` versus empty, or zero versus absent, to carry meaning.

## Interface values need Register

An interface field holds a value of some concrete type. gob cannot know which types might appear,
so you must **register** each one before encoding or decoding:

```go title="c/main.go"
package main

import (
	"bytes"
	"encoding/gob"
	"fmt"
)

type Shape interface{ Area() float64 }

type Circle struct{ R float64 }
type Rect struct{ W, H float64 }

func (c Circle) Area() float64 { return 3 * c.R * c.R }
func (r Rect) Area() float64   { return r.W * r.H }

type Drawing struct {
	Shapes []Shape
}

func main() {
	d := Drawing{Shapes: []Shape{Circle{2}, Rect{3, 4}}}

	var buf bytes.Buffer
	err := gob.NewEncoder(&buf).Encode(d)
	fmt.Println("without Register:", err)

	gob.Register(Circle{})
	gob.Register(Rect{})
	buf.Reset()
	if err := gob.NewEncoder(&buf).Encode(d); err != nil {
		fmt.Println(err)
		return
	}
	var back Drawing
	if err := gob.NewDecoder(&buf).Decode(&back); err != nil {
		fmt.Println(err)
		return
	}
	for _, s := range back.Shapes {
		fmt.Printf("%T %v\n", s, s.Area())
	}
}
```

```text
without Register: gob: type not registered for interface: main.Circle
main.Circle 12
main.Rect 12
```

`gob.Register(Circle{})` records the type under a name; the stream carries that name, and the
decoder uses it to create the right concrete value. Without registration, `Encode` fails with
`gob: type not registered for interface: main.Circle`. The decoder needs the same registrations
as the encoder, so put `gob.Register` calls in an `init` function in the package that defines the
types, so both sides run them. `gob.RegisterName` fixes the name when you move or rename a type.

> [!WARNING]
> A missing `gob.Register` on the **decoding** side shows up at read time, often only in
> production, because tests that encode and decode in one process register once for both.
> Symptom: `gob: name not registered for interface: "main.Circle"` when another program or a
> later run reads the data. Fix: register in `init` next to the type, and test by decoding in a
> fresh process.

## One encoder per stream

The type descriptions are sent the first time an `Encoder` sees a type. Reusing the encoder keeps
the stream small; a new `Encoder` for each value sends the descriptions again:

```go title="d/main.go"
package main

import (
	"bytes"
	"encoding/gob"
	"fmt"
)

type Msg struct {
	ID   int
	Body string
}

func main() {
	// One encoder for the whole stream: the type description is sent once.
	var one bytes.Buffer
	enc := gob.NewEncoder(&one)
	for i := range 3 {
		enc.Encode(Msg{i, "hello"})
	}
	fmt.Println("one encoder:", one.Len())

	// A new encoder per value resends the type every time.
	var many bytes.Buffer
	for i := range 3 {
		gob.NewEncoder(&many).Encode(Msg{i, "hello"})
	}
	fmt.Println("encoder per value:", many.Len())

	dec := gob.NewDecoder(&one)
	for {
		var m Msg
		if err := dec.Decode(&m); err != nil {
			fmt.Println(err)
			break
		}
		fmt.Printf("%+v\n", m)
	}
}
```

```text
one encoder: 70
encoder per value: 136
{ID:0 Body:hello}
{ID:1 Body:hello}
{ID:2 Body:hello}
EOF
```

For messages over a connection or lines in a log file, create one `Encoder` and one `Decoder` for
the lifetime of the stream, and let the decoder return `io.EOF` at the end. A second `Decoder`
over the middle of a stream cannot decode, because it missed the type descriptions.

## Custom encodings, security and when to use it

A type that implements `GobEncode() ([]byte, error)` and `GobDecode([]byte) error` (or
`encoding.BinaryMarshaler`/`BinaryUnmarshaler`) controls its own form. This is how types with only
unexported fields, such as `time.Time` and `big.Int`, work with gob.

Reach for `gob` when both ends are Go programs you control and you want zero schema work: an
on-disk cache, a task queue between your own services. Do not use it for:

- **Other languages**: there are no gob libraries outside Go.
- **Untrusted input**: the decoder allocates what the stream says. Limit the size of what you read
  (`io.LimitReader`) and prefer JSON with validation for anything from the network.
- **Long-term storage you want to inspect**: you cannot read or edit the data without a Go
  program.

linkcheck does **not** use gob for its saved state: it writes gzipped JSON so a person can read
and debug it, in [[step-8-state]].
