---
title: Custom JSON encoding
---
The default mapping from Go values to JSON is fine for plain structs. It is not enough when a
type has a better wire form than its Go form: an enum that should read `"broken"` rather than
`1`, a duration that should read `"1m30s"`, a type whose JSON shape depends on a field.
`encoding/json` lets a type take over its own encoding by implementing an interface.

| Interface | Methods | Used for |
|---|---|---|
| `json.Marshaler` | `MarshalJSON() ([]byte, error)` | Produces a complete JSON value |
| `json.Unmarshaler` | `UnmarshalJSON([]byte) error` | Parses a complete JSON value |
| `encoding.TextMarshaler` | `MarshalText() ([]byte, error)` | Written as a JSON **string**; also usable as a **map key** |
| `encoding.TextUnmarshaler` | `UnmarshalText([]byte) error` | Read from a JSON string or a map key |

When a type has both, the JSON methods win. The package checks for these methods on every value
it encodes or decodes, at any depth: slices, maps and struct fields included.

## An enum with names: MarshalJSON and UnmarshalJSON

```go title="g/main.go"
package main

import (
	"encoding/json"
	"fmt"
	"strings"
)

type Status int

const (
	StatusOK Status = iota
	StatusBroken
	StatusSkipped
)

var statusNames = [...]string{"ok", "broken", "skipped"}

func (s Status) String() string { return statusNames[s] }

// MarshalJSON writes the name instead of the number.
func (s Status) MarshalJSON() ([]byte, error) {
	return json.Marshal(s.String())
}

// UnmarshalJSON must have a pointer receiver: it changes *s.
func (s *Status) UnmarshalJSON(b []byte) error {
	var name string
	if err := json.Unmarshal(b, &name); err != nil {
		return fmt.Errorf("status: want a JSON string: %w", err)
	}
	for i, n := range statusNames {
		if strings.EqualFold(n, name) {
			*s = Status(i)
			return nil
		}
	}
	return fmt.Errorf("status: unknown value %q", name)
}

type Result struct {
	URL    string `json:"url"`
	Status Status `json:"status"`
}

func main() {
	out, err := json.Marshal([]Result{{"a", StatusOK}, {"b", StatusBroken}})
	fmt.Println(string(out), err)

	var rs []Result
	err = json.Unmarshal([]byte(`[{"url":"c","status":"Skipped"}]`), &rs)
	fmt.Println(rs, err)

	err = json.Unmarshal([]byte(`[{"url":"c","status":"gone"}]`), &rs)
	fmt.Println(err)
	err = json.Unmarshal([]byte(`[{"url":"c","status":2}]`), &rs)
	fmt.Println(err)

	// As a map key: Status has no MarshalText, so the int is used.
	out, err = json.Marshal(map[Status]int{StatusOK: 3})
	fmt.Println(string(out), err)
}
```

```bash
go run ./g
```

```text
[{"url":"a","status":"ok"},{"url":"b","status":"broken"}] <nil>
[{c skipped}] <nil>
status: unknown value "gone"
status: want a JSON string: json: cannot unmarshal number into Go value of type string
{"0":3} <nil>
```

How it works:

- **`MarshalJSON` returns a complete, valid JSON value.** Here it calls `json.Marshal` on the
  name so the quotes and escaping are right. Never build JSON by string concatenation.
- **`UnmarshalJSON` must have a pointer receiver**, because it changes the value. It receives the
  raw bytes of one JSON value (for a string, including the quotes) and must copy them if it keeps
  them. Return a descriptive error: the caller sees it as the result of `Unmarshal`.
- Matching is up to you: `strings.EqualFold` accepts `Skipped` and `skipped`.
- A number where a name is expected is rejected by *our* code, with its own message.
- The last line shows what the interface does **not** cover: as a **map key** the type has no
  `MarshalText`, so the key is the integer (`{"0":3}`). Types used as map keys need the text
  interfaces.

## Text interfaces: strings and map keys

```go title="h/main.go"
package main

import (
	"encoding/json"
	"fmt"
	"strings"
)

type Level int

const (
	Info Level = iota
	Warn
)

func (l Level) MarshalText() ([]byte, error) {
	return []byte([]string{"info", "warn"}[l]), nil
}

func (l *Level) UnmarshalText(b []byte) error {
	switch strings.ToLower(string(b)) {
	case "info":
		*l = Info
	case "warn":
		*l = Warn
	default:
		return fmt.Errorf("unknown level %q", b)
	}
	return nil
}

func main() {
	counts := map[Level]int{Info: 10, Warn: 2}
	out, err := json.Marshal(struct {
		Min    Level         `json:"min"`
		Counts map[Level]int `json:"counts"`
	}{Warn, counts})
	fmt.Println(string(out), err)

	var back struct {
		Min    Level
		Counts map[Level]int
	}
	err = json.Unmarshal(out, &back)
	fmt.Println(back.Min == Warn, back.Counts[Info], back.Counts[Warn], err)
}
```

```text
{"min":"warn","counts":{"info":10,"warn":2}} <nil>
true 10 2 <nil>
```

Implementing `MarshalText` and `UnmarshalText` gives the type a string form that works as a JSON
string value, as a map key, and also in other formats that use text encoding (`encoding/xml`
attributes and `flag.TextVar`). For an enum this is the better choice
than `MarshalJSON`: less code, and map keys work. Types in the standard library do this:
`time.Time`, `net/netip.Addr`, `math/big.Int` and Go 1.27's `uuid.UUID` all
implement the text methods (`time.Time` and `big.Int` also have JSON methods), so they work in JSON without any code from you.

## A duration, and the recursion trap

```go title="i/main.go"
package main

import (
	"encoding/json"
	"fmt"
	"time"
)

// Duration wraps time.Duration to read and write "1m30s".
type Duration struct{ time.Duration }

func (d Duration) MarshalJSON() ([]byte, error) {
	return json.Marshal(d.String())
}

func (d *Duration) UnmarshalJSON(b []byte) error {
	var s string
	if err := json.Unmarshal(b, &s); err != nil {
		return err
	}
	v, err := time.ParseDuration(s)
	if err != nil {
		return err
	}
	d.Duration = v
	return nil
}

type Config struct {
	Timeout Duration `json:"timeout"`
}

// Wrong: calling json.Marshal on the same type recurses forever.
// Right: convert to a type without the method.
type Event struct {
	Name string `json:"name"`
	At   int    `json:"at"`
}

func (e Event) MarshalJSON() ([]byte, error) {
	type plain Event // same fields, no methods
	return json.Marshal(struct {
		plain
		Kind string `json:"kind"`
	}{plain(e), "event"})
}

func main() {
	var c Config
	err := json.Unmarshal([]byte(`{"timeout":"1m30s"}`), &c)
	fmt.Println(c.Timeout, err)
	out, _ := json.Marshal(c)
	fmt.Println(string(out))
	err = json.Unmarshal([]byte(`{"timeout":"soon"}`), &c)
	fmt.Println(err)

	out, err = json.Marshal(Event{"deploy", 5})
	fmt.Println(string(out), err)
}
```

```text
1m30s <nil>
{"timeout":"1m30s"}
time: invalid duration "soon"
{"name":"deploy","at":5,"kind":"event"} <nil>
```

`Duration` embeds `time.Duration` so it keeps its methods (`String`, `Seconds`) and adds JSON
methods that read and write `"1m30s"`. A config file with `"timeout": "1m30s"` is much friendlier
than `90000000000`. The bad value `"soon"` fails with the error from `time.ParseDuration`.

`Event.MarshalJSON` shows how to **add to** the default encoding without calling itself. Inside
a `MarshalJSON` method, `json.Marshal(e)` would find the method again and recurse until the stack
overflows. Define `type plain Event`: a new type with the same fields and **none of the methods**.
Marshal that, embedded in a struct with the extra field.

> [!WARNING]
> Calling `json.Marshal` on the receiver (or `json.Unmarshal` into it) inside its own
> `MarshalJSON`/`UnmarshalJSON` recurses forever. Symptom: `goroutine stack exceeds 1000000000-byte
> limit` and a crash. Fix: convert to a method-less type with the same layout (`type plain T`),
> as above.

## Pointer receivers need an addressable value

```go title="j/main.go"
package main

import (
	"encoding/json"
	"fmt"
)

type Counter struct{ N int }

// Pointer receiver: only used when the value is addressable.
func (c *Counter) MarshalJSON() ([]byte, error) {
	return []byte(fmt.Sprintf(`"n=%d"`, c.N)), nil
}

type Holder struct {
	C Counter
}

func main() {
	c := Counter{3}
	a, _ := json.Marshal(c)  // value: method not in the method set
	b, _ := json.Marshal(&c) // pointer: method used
	h, _ := json.Marshal(Holder{c})
	hp, _ := json.Marshal(&Holder{c})
	fmt.Println(string(a), string(b), string(h), string(hp))
}
```

```text
{"N":3} "n=3" {"C":{"N":3}} {"C":"n=3"}
```

`MarshalJSON` has a pointer receiver here. `json.Marshal(c)` receives a **copy**, which is not
addressable, so the method is not in the value's method set and the default encoding runs
(`{"N":3}`). `json.Marshal(&c)` calls it. Inside a struct the same rule applies: the field is
encoded with the method only when the struct itself is reachable through a pointer
(`&Holder{c}`).

> [!WARNING]
> A pointer-receiver `MarshalJSON` that is skipped for values is silent. Symptom: your custom
> format shows up in some places (when you pass a pointer) and not in others (a slice of
> values, a struct field in a value). Fix: define `MarshalJSON` and `MarshalText` on the **value**
> receiver. `UnmarshalJSON` and `UnmarshalText` always use the pointer receiver.

## Polymorphic JSON with RawMessage

When the shape depends on a field (`{"type":"point","data":{...}}`), decode `data` as
`json.RawMessage` first ([[json]]), read `type`, then decode the raw bytes into the right
struct. Put that switch in an `UnmarshalJSON` method on the wrapper type and the rest of your
program deals with ordinary Go values.

## The v2 way (Go 1.27)

`encoding/json/v2` keeps `MarshalJSON` and `UnmarshalJSON` (and the text interfaces), so your
types work with both packages. It adds two things.

**Streaming methods.** `MarshalJSONTo(*jsontext.Encoder) error` and `UnmarshalJSONFrom(*jsontext.Decoder)
error` write and read tokens directly, with no intermediate `[]byte` and with error positions
that are correct.

**Functions that customise a type you do not own.** `json.MarshalFunc` and `json.UnmarshalFunc`
build a custom (un)marshaler for any type `T`, and `WithMarshalers` / `WithUnmarshalers` pass it as
an option for one call. That is how you supply the representation for `time.Duration`, which
v2 refuses to guess:

```go title="k/main.go"
package main

import (
	"encoding/json/jsontext"
	jsonv2 "encoding/json/v2"
	"fmt"
	"time"
)

type Point struct{ X, Y int }

// MarshalJSONTo writes straight to the encoder: no intermediate []byte.
func (p Point) MarshalJSONTo(enc *jsontext.Encoder) error {
	if err := enc.WriteToken(jsontext.BeginArray); err != nil {
		return err
	}
	if err := enc.WriteToken(jsontext.Int(int64(p.X))); err != nil {
		return err
	}
	if err := enc.WriteToken(jsontext.Int(int64(p.Y))); err != nil {
		return err
	}
	return enc.WriteToken(jsontext.EndArray)
}

// UnmarshalJSONFrom reads tokens from the decoder.
func (p *Point) UnmarshalJSONFrom(dec *jsontext.Decoder) error {
	var xy [2]int
	if err := jsonv2.UnmarshalDecode(dec, &xy); err != nil {
		return err
	}
	p.X, p.Y = xy[0], xy[1]
	return nil
}

type Job struct {
	At   Point         `json:"at"`
	Wait time.Duration `json:"wait"`
}

func main() {
	// A caller-supplied marshaler for a type you do not own.
	opts := jsonv2.JoinOptions(
		jsonv2.WithMarshalers(jsonv2.MarshalFunc(func(d time.Duration) ([]byte, error) {
			return jsonv2.Marshal(d.String())
		})),
		jsonv2.WithUnmarshalers(jsonv2.UnmarshalFunc(func(b []byte, d *time.Duration) error {
			var s string
			if err := jsonv2.Unmarshal(b, &s); err != nil {
				return err
			}
			v, err := time.ParseDuration(s)
			*d = v
			return err
		})),
	)

	out, err := jsonv2.Marshal(Job{Point{1, 2}, 90 * time.Second}, opts)
	fmt.Println(string(out), err)

	var j Job
	err = jsonv2.Unmarshal([]byte(`{"at":[5,6],"wait":"2m"}`), &j, opts)
	fmt.Println(j, err)

	_, err = jsonv2.Marshal(Job{}) // without the option
	fmt.Println(err)
}
```

```text
{"at":[1,2],"wait":"1m30s"} <nil>
{{5 6} 2m0s} <nil>
json: cannot marshal from Go time.Duration within "/wait": no default representation
```

The last line is the error v2 gives for a `time.Duration` field with no marshaler. In v1 the
same field was written as nanoseconds, which is rarely what an API wants. In v2 the choice is
explicit, either through the options above or by wrapping the type, as in the `Duration` example.

> [!NOTE]
> A `MarshalJSON` method that returns invalid JSON makes `Marshal` fail in v1 (`json: error calling
> MarshalJSON for type ...`). In both packages, keep the method deterministic and cheap, and test
> it with a round trip: marshal, unmarshal, compare.

linkcheck's `Outcome` type is a text-marshalled enum so the JSON report says `"broken"` rather
than `1`, in [[step-7-reporters]].
