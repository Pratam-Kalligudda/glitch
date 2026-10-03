---
title: encoding/json
done_when: "You marshal and unmarshal structs with tags, read JSON from a stream, check the errors, and can say what encoding/json and encoding/json/v2 do differently in Go 1.27."
---
JSON is the format most programs use to talk to other programs: HTTP APIs, config files,
saved state. `encoding/json` converts between JSON text and Go values. **Marshal** turns a Go
value into JSON; **unmarshal** parses JSON into a Go value. The package decides how to map
fields by looking at the value's type with reflection, steered by **struct tags**: the
backquoted text after a field, such as `` `json:"url"` ``.

## Marshal: Go value to JSON

```go title="a/main.go"
package main

import (
	"encoding/json"
	"fmt"
	"log"
	"time"
)

type Link struct {
	URL       string    `json:"url"`
	Status    int       `json:"status"`
	Error     string    `json:"error,omitempty"`
	Tags      []string  `json:"tags"`
	CheckedAt time.Time `json:"checked_at,omitzero"`
	Redirect  *Link     `json:"redirect,omitempty"`
	secret    string    // unexported: never encoded
	Internal  string    `json:"-"` // exported but skipped
	ID        int64     `json:"id,string"`
}

func main() {
	l := Link{
		URL:    "https://go.dev/doc?a=1&b=2",
		Status: 200,
		ID:     1234567890123,
		secret: "x",
	}
	data, err := json.Marshal(l)
	if err != nil {
		log.Fatal(err)
	}
	fmt.Println(string(data))

	l.CheckedAt = time.Date(2026, 10, 3, 9, 30, 0, 0, time.UTC)
	l.Tags = []string{}
	l.Redirect = &Link{URL: "https://go.dev/", Status: 200}
	pretty, _ := json.MarshalIndent(l, "", "  ")
	fmt.Println(string(pretty))
}
```

```bash
go run ./a
```

```text
{"url":"https://go.dev/doc?a=1\u0026b=2","status":200,"tags":null,"id":"1234567890123"}
{
  "url": "https://go.dev/doc?a=1\u0026b=2",
  "status": 200,
  "tags": [],
  "checked_at": "2026-10-03T09:30:00Z",
  "redirect": {
    "url": "https://go.dev/",
    "status": 200,
    "tags": null,
    "id": "0"
  },
  "id": "1234567890123"
}
```

The rules the output shows:

- **Only exported fields** (capital first letter) are encoded. `secret` is skipped, because
  the package lives outside yours and cannot see unexported fields.
- **The tag renames and configures a field.** `json:"url"` makes the JSON key `url`.
  Without a tag the key is the Go field name (`Internal`, if it were not skipped).
- **`json:"-"`** skips the field entirely.
- **`,omitempty`** drops the field when its value is "empty": `false`, `0`, a nil pointer, a nil
  interface, and an empty array, slice, map or string. It does **not** drop a struct, so
  `omitempty` on a `time.Time` does nothing.
- **`,omitzero`** (Go 1.24) drops the field when it is the zero value of its type, or when
  its `IsZero() bool` method returns true. That is the right option for `time.Time` and for
  structs. `CheckedAt` disappeared in the first output and appeared in the second.
- **`,string`** writes a number (or bool) as a JSON string, as in `"id":"1234567890123"`.
  Use it when the reader of your JSON is JavaScript, whose numbers lose integers above 2^53.
- **A nil slice is `null`; an empty slice is `[]`.** `Tags` shows both. Initialise with
  `[]string{}` when a client expects an array.
- **`&`, `<` and `>` are escaped** as `&`, `<` and `>`, so JSON can be embedded in
  HTML safely. It is valid JSON and decodes back to the same text. `Encoder.SetEscapeHTML(false)`
  turns it off (see streaming below).
- **Maps** are written with sorted keys; **`[]byte`** as a base64 string; **`time.Time`** as an
  RFC 3339 string; **pointers** as the value they point to, or `null`.
- **Channels, functions and complex numbers** cannot be encoded: `Marshal` returns an
  `*json.UnsupportedTypeError`. A cyclic structure returns an error too.

`json.MarshalIndent(v, prefix, indent)` produces the readable, multi-line form.

### Type mapping

| JSON | Go type when encoding | Go type when decoding into `any` |
|---|---|---|
| object | struct, `map[string]T` | `map[string]any` |
| array | slice, array | `[]any` |
| string | `string`, `[]byte` (base64), `time.Time`, any `TextMarshaler` | `string` |
| number | all integer and float types | `float64` |
| `true` / `false` | `bool` | `bool` |
| `null` | nil pointer, interface, slice, map | `nil` |

## Unmarshal: JSON to Go value

```go title="b/main.go"
package main

import (
	"encoding/json"
	"errors"
	"fmt"
)

type Config struct {
	Depth   int      `json:"depth"`
	Hosts   []string `json:"hosts"`
	Timeout float64  `json:"timeout"`
	Nested  struct {
		Verbose bool `json:"verbose"`
	} `json:"nested"`
}

func main() {
	in := []byte(`{"DEPTH": 3, "hosts": ["a.com","b.com"], "timeout": 1.5, "nested": {"verbose": true}, "unknown": 1}`)

	var c Config
	if err := json.Unmarshal(in, &c); err != nil {
		fmt.Println("error:", err)
		return
	}
	fmt.Printf("%+v\n", c)

	// Errors.
	var se *json.SyntaxError
	err := json.Unmarshal([]byte(`{"depth": 3,}`), &c)
	if errors.As(err, &se) {
		fmt.Println("syntax error at offset", se.Offset, "-", se)
	}

	var te *json.UnmarshalTypeError
	err = json.Unmarshal([]byte(`{"depth": "three"}`), &c)
	if errors.As(err, &te) {
		fmt.Println("type error:", te.Field, te.Value, te.Type, te.Offset)
	}

	err = json.Unmarshal([]byte(`{"depth": 3}`), c) // not a pointer
	fmt.Println(err)
	var ip *json.InvalidUnmarshalError
	fmt.Println(errors.As(err, &ip))

	// Unmarshal keeps what it could decode.
	c = Config{}
	err = json.Unmarshal([]byte(`{"depth": "x", "timeout": 9}`), &c)
	fmt.Println(c.Timeout, err != nil)
}
```

```text
{Depth:3 Hosts:[a.com b.com] Timeout:1.5 Nested:{Verbose:true}}
syntax error at offset 13 - invalid character '}' looking for beginning of object key string
type error: depth string int 17
json: Unmarshal(non-pointer main.Config)
true
9 true
```

How it works:

- **Pass a pointer** (`&c`). Passing the value itself returns `*json.InvalidUnmarshalError`
  (`json: Unmarshal(non-pointer main.Config)`).
- **Names match case-insensitively** in `json.Unmarshal`: `"DEPTH"` filled `Depth`. An exact
  match is preferred when several fields match.
- **Unknown keys are ignored**, unless you use a `Decoder` with `DisallowUnknownFields` (below).
- **Missing keys leave the field untouched.** The target is not reset first, so a populated
  struct keeps the values that are not in the JSON. Decode into a fresh value when you do not
  want that.
- **Errors tell you where.** A `*json.SyntaxError` has the byte `Offset`. A
  `*json.UnmarshalTypeError` has `Field`, `Value` (what the JSON held), `Type` (what the Go
  type wanted) and `Offset`. Use `errors.As` ([[is-as]]) to read them and build a precise
  message for the user.
- **Decoding keeps going after a type error.** `Unmarshal` stores every field it can and returns
  the first type error at the end: `Timeout` was set to `9` though `depth` failed. Do not use
  a partially filled value after an error.

More decoding rules, shown by running them:

```go title="e/main.go"
package main

import (
	"encoding/json"
	"fmt"
	"time"
)

type Report struct {
	Title string
	count int // unexported: silently ignored both ways
	Items []string
	Meta  map[string]int
	Child struct{ A, B int }
	When  time.Time `json:"when,omitempty"`
	Zero  time.Time `json:"zero,omitzero"`
}

func main() {
	r := Report{Title: "t", count: 5}
	b, _ := json.Marshal(r)
	fmt.Println(string(b))

	// Unmarshal into a populated value: fields not in the JSON stay.
	r2 := Report{Title: "old", Items: []string{"a", "b", "c"}, Meta: map[string]int{"keep": 1}}
	r2.Child.A = 7
	json.Unmarshal([]byte(`{"Items":["x"],"Meta":{"new":2},"Child":{"B":9}}`), &r2)
	fmt.Println(r2.Title, r2.Items, r2.Meta, r2.Child)

	// null leaves values alone; decoding into pointers allocates.
	var p struct {
		N *int
		S string
	}
	json.Unmarshal([]byte(`{"N":5,"S":null}`), &p)
	fmt.Println(*p.N, p.S == "")

	var f float64
	var i int
	fmt.Println(json.Unmarshal([]byte(`1e2`), &f), f)
	fmt.Println(json.Unmarshal([]byte(`1e2`), &i), i)
	fmt.Println(json.Unmarshal([]byte(`1.5`), &i), i)
	fmt.Println(json.Valid([]byte(`{"a":}`)), json.Valid([]byte(`[1,2]`)))
}
```

```text
{"Title":"t","Items":null,"Meta":null,"Child":{"A":0,"B":0},"when":"0001-01-01T00:00:00Z"}
old [x] map[keep:1 new:2] {7 9}
5 true
<nil> 100
json: cannot unmarshal number 1e2 into Go value of type int 0
json: cannot unmarshal number 1.5 into Go value of type int 0
false true
```

Read the output line by line: unexported `count` is neither written nor read; `Items` is
replaced, not appended to; map entries are **added** to the existing map (`keep` stayed, `new`
arrived); the nested struct merged (`A` stayed 7, `B` became 9); `null` into a string leaves
it alone; a pointer field is allocated when the value is not `null`; and `1e2` fits a `float64`
but not an `int`, nor does `1.5`.

## Unknown shapes: any, Number, RawMessage

```go title="c/main.go"
package main

import (
	"bytes"
	"encoding/json"
	"fmt"
)

func main() {
	in := []byte(`{"name":"go","n":42,"big":12345678901234567890,"ok":true,"tags":["a","b"],"nested":{"x":null}}`)

	var v any
	if err := json.Unmarshal(in, &v); err != nil {
		panic(err)
	}
	m := v.(map[string]any)
	for _, k := range []string{"name", "n", "big", "ok", "tags", "nested"} {
		fmt.Printf("%-6s %T %v\n", k, m[k], m[k])
	}

	// json.Number keeps the digits.
	var raw map[string]any
	dec := json.NewDecoder(bytes.NewReader(in))
	dec.UseNumber()
	dec.Decode(&raw)
	n := raw["big"].(json.Number)
	fmt.Println(n, n.String())
	_, err := n.Int64()
	fmt.Println(err)

	// RawMessage delays decoding.
	var env struct {
		Type string          `json:"type"`
		Data json.RawMessage `json:"data"`
	}
	json.Unmarshal([]byte(`{"type":"point","data":{"x":1,"y":2}}`), &env)
	fmt.Println(env.Type, string(env.Data))
	var p struct{ X, Y int }
	json.Unmarshal(env.Data, &p)
	fmt.Println(p)
}
```

```text
name   string go
n      float64 42
big    float64 1.2345678901234567e+19
ok     bool true
tags   []interface {} [a b]
nested map[string]interface {} map[x:<nil>]
12345678901234567890 12345678901234567890
strconv.ParseInt: parsing "12345678901234567890": value out of range
point {"x":1,"y":2}
{1 2}
```

Decoding into `any` gives `map[string]any`, `[]any`, `string`, `bool`, `nil` and, for **every**
number, `float64`. A number such as `12345678901234567890` does not fit a `float64` exactly: it
printed as `1.2345678901234567e+19`, losing digits. Ask the `Decoder` for `UseNumber()` to get a
`json.Number` (a string type holding the exact digits) and convert it with `Int64()`, `Float64()`
or `String()` when you know the target. Typical case: 64-bit IDs.

`json.RawMessage` is a `[]byte` that stores a value **undecoded**. It lets you read a `type` field
first and decode `data` into the right struct afterwards, or pass a sub-document through
unchanged.

## Streams: Encoder and Decoder

`json.Marshal` and `Unmarshal` work on a whole `[]byte`. For files, network connections and
big inputs, wrap an `io.Writer` or `io.Reader` ([[io-composition]]):

```go title="d/main.go"
package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
)

type Result struct {
	URL    string `json:"url"`
	Status int    `json:"status"`
}

func main() {
	// 1. Encoder: one JSON value per line (NDJSON / JSON Lines).
	enc := json.NewEncoder(os.Stdout)
	for _, r := range []Result{{"https://a.example", 200}, {"https://b.example/?q=1&x=2", 404}} {
		if err := enc.Encode(r); err != nil {
			fmt.Println(err)
		}
	}
	enc.SetEscapeHTML(false)
	enc.Encode(Result{"https://c.example/?q=1&x=2", 200})
	enc.SetIndent("", " ")
	enc.Encode(Result{"https://d.example", 500})

	// 2. Decoder: read a stream of values.
	stream := `{"url":"https://a.example","status":200}
{"url":"https://b.example","status":404}
{"url":"https://c.example","status":"oops"}
`
	dec := json.NewDecoder(strings.NewReader(stream))
	for {
		var r Result
		err := dec.Decode(&r)
		if err == io.EOF {
			break
		}
		if err != nil {
			fmt.Println("decode error:", err)
			break
		}
		fmt.Printf("%+v\n", r)
	}

	// 3. Strict decoding: unknown fields and trailing data.
	dec = json.NewDecoder(strings.NewReader(`{"url":"x","staus":200}`))
	dec.DisallowUnknownFields()
	var r Result
	fmt.Println(dec.Decode(&r))

	dec = json.NewDecoder(strings.NewReader(`{"url":"x"} {"url":"y"}`))
	dec.Decode(&r)
	fmt.Println("more data:", dec.More())
	if err := dec.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		fmt.Println("trailing value present")
	}

	// 4. A big array, element by element, with Token.
	dec = json.NewDecoder(strings.NewReader(`[{"url":"a","status":1},{"url":"b","status":2}]`))
	tok, _ := dec.Token() // the opening [
	fmt.Printf("%T %v\n", tok, tok)
	for dec.More() {
		var r Result
		dec.Decode(&r)
		fmt.Println(r.URL, r.Status)
	}
	tok, _ = dec.Token() // the closing ]
	fmt.Println(tok)
}
```

```text
{"url":"https://a.example","status":200}
{"url":"https://b.example/?q=1\u0026x=2","status":404}
{"url":"https://c.example/?q=1&x=2","status":200}
{
 "url": "https://d.example",
 "status": 500
}
{URL:https://a.example Status:200}
{URL:https://b.example Status:404}
decode error: json: cannot unmarshal string into Go struct field Result.status of type int
json: unknown field "staus"
more data: true
trailing value present
json.Delim [
a 1
b 2
]
```

- `json.NewEncoder(w).Encode(v)` writes one value and a newline. Calling it repeatedly makes
  **JSON Lines** (one JSON value per line), which is easy to append to and to process line by
  line. `SetEscapeHTML(false)` keeps `&` as `&`, and `SetIndent(prefix, indent)` pretty-prints.
- `json.NewDecoder(r).Decode(&v)` reads the next value from the stream and returns `io.EOF` when
  there is none. It reads ahead into a buffer, so do not share the reader with other code.
- **`DisallowUnknownFields()`** turns a typo such as `"staus"` into an error
  (`json: unknown field "staus"`). Use it for config files.
- **Trailing data** is not noticed by one `Decode`: `{"url":"x"} {"url":"y"}` decodes the first
  value fine. Check `dec.More()` or try a second `Decode` and expect `io.EOF`.
- **`dec.Token()` and `dec.More()`** walk a large array one element at a time, so you never hold
  the whole array in memory.

> [!WARNING]
> Reading an HTTP request body with `io.ReadAll` and `Unmarshal` lets a client send gigabytes.
> Symptom: memory spikes or a killed process under a large or hostile request. Fix: wrap the
> body with `http.MaxBytesReader` and decode with a `Decoder`, which also gives you
> `DisallowUnknownFields` ([[http-server]]).

> [!WARNING]
> Decoding into `any` and indexing blindly (`m["n"].(int)`) panics: numbers are `float64`.
> Symptom: `interface conversion: interface {} is float64, not int`. Fix: decode into a struct,
> use the comma-ok form, or `UseNumber`. Also remember that a **nil** slice marshals to `null`,
> which some clients treat as an error: initialise with `[]T{}`.

## Go 1.27: encoding/json is backed by encoding/json/v2

Go 1.27 adds two packages and changes how the old one works inside.

- **`encoding/json/v2`** is a new major version of the package with a new API and **stricter,
  safer defaults**: `Marshal`, `MarshalWrite`, `MarshalEncode`, `Unmarshal`, `UnmarshalRead` and
  `UnmarshalDecode`, each taking any number of options.
- **`encoding/json/jsontext`** is the lower-level layer: it deals only with the syntax of JSON
  (`Encoder`, `Decoder`, `Token`, `Value`) and holds the options that control text, such as
  `Multiline` and `WithIndent`.
- **`encoding/json` (v1) now runs on top of v2.** Its API and its behaviour are unchanged: the
  v1 functions call v2 with options that switch on the old behaviour. You do not have to
  migrate, and everything above still holds. What you can notice: error **message text** may
  differ from earlier releases, and decoding is much faster (the release notes report marshalling
  at parity and unmarshalling significantly faster). `GOEXPERIMENT=nojsonv2` at build time
  restores the old implementation; it is expected to be removed in a future release.

What v2 does differently by default, from running both on the same values (Go 1.27.1):

```go title="v1v2/main.go"
package main

import (
	"encoding/json"
	jsonv2 "encoding/json/v2"
	"fmt"
	"time"
)

type Row struct {
	Name  string   `json:"name"`
	Tags  []string `json:"tags"`
	Attrs map[string]int
}

type Opt struct {
	N  int       `json:"n,omitempty"`
	S  string    `json:"s,omitempty"`
	Sl []int     `json:"sl,omitempty"`
	P  *int      `json:"p,omitempty"`
	T  time.Time `json:"t,omitempty"`
	St struct{}  `json:"st,omitempty"`
	Z  time.Time `json:"z,omitzero"`
	B  bool      `json:"b,omitempty"`
}

type Dur struct {
	D time.Duration
	A [3]byte
	B []byte
}

type U struct {
	UserName string `json:"user_name"`
}

func show(label string, v1 []byte, e1 error, v2 []byte, e2 error) {
	fmt.Printf("%-14s v1: %s %v\n", label, v1, errStr(e1))
	fmt.Printf("%-14s v2: %s %v\n", "", v2, errStr(e2))
}

func errStr(e error) string {
	if e == nil {
		return ""
	}
	return "ERR: " + e.Error()
}

func main() {
	r := Row{Name: "a<b>&"}
	a, e1 := json.Marshal(r)
	b, e2 := jsonv2.Marshal(r)
	show("nil slice/map", a, e1, b, e2)

	o := Opt{}
	a, e1 = json.Marshal(o)
	b, e2 = jsonv2.Marshal(o)
	show("omitempty", a, e1, b, e2)

	d := Dur{D: time.Second, A: [3]byte{1, 2, 3}, B: []byte("hi")}
	a, e1 = json.Marshal(d)
	b, e2 = jsonv2.Marshal(d)
	show("duration/bytes", a, e1, b, e2)

	m := map[string]int{"b": 2, "a": 1, "c": 3}
	a, e1 = json.Marshal(m)
	b, e2 = jsonv2.Marshal(m)
	show("map order", a, e1, b, e2)
	b, e2 = jsonv2.Marshal(m, jsonv2.Deterministic(true))
	fmt.Printf("%-14s v2 det: %s\n", "", b)

	var u1, u2 U
	e1 = json.Unmarshal([]byte(`{"USER_NAME":"x"}`), &u1)
	e2 = jsonv2.Unmarshal([]byte(`{"USER_NAME":"x"}`), &u2)
	fmt.Printf("%-14s v1: %+v %v\n%-14s v2: %+v %v\n", "case match", u1, errStr(e1), "", u2, errStr(e2))

	u1, u2 = U{}, U{}
	e1 = json.Unmarshal([]byte(`{"user_name":"x","user_name":"y"}`), &u1)
	e2 = jsonv2.Unmarshal([]byte(`{"user_name":"x","user_name":"y"}`), &u2)
	fmt.Printf("%-14s v1: %+v %v\n%-14s v2: %+v %v\n", "duplicate", u1, errStr(e1), "", u2, errStr(e2))

	u1, u2 = U{}, U{}
	e1 = json.Unmarshal([]byte("{\"user_name\":\"a\xffb\"}"), &u1)
	e2 = jsonv2.Unmarshal([]byte("{\"user_name\":\"a\xffb\"}"), &u2)
	fmt.Printf("%-14s v1: %q %v\n%-14s v2: %q %v\n", "bad utf-8", u1.UserName, errStr(e1), "", u2.UserName, errStr(e2))

	u1, u2 = U{}, U{}
	e1 = json.Unmarshal([]byte(`{"user_name":"x","extra":1}`), &u1)
	e2 = jsonv2.Unmarshal([]byte(`{"user_name":"x","extra":1}`), &u2, jsonv2.RejectUnknownMembers(true))
	fmt.Printf("%-14s v1: %+v %v\n%-14s v2 reject: %+v %v\n", "unknown", u1, errStr(e1), "", u2, errStr(e2))
}
```

```text
nil slice/map  v1: {"name":"a\u003cb\u003e\u0026","tags":null,"Attrs":null} 
               v2: {"name":"a<b>&","tags":[],"Attrs":{}} 
omitempty      v1: {"t":"0001-01-01T00:00:00Z","st":{}} 
               v2: {"n":0,"t":"0001-01-01T00:00:00Z","b":false} 
duration/bytes v1: {"D":1000000000,"A":[1,2,3],"B":"aGk="} 
               v2: {"D" ERR: json: cannot marshal from Go time.Duration within "/D": no default representation
map order      v1: {"a":1,"b":2,"c":3} 
               v2: {"b":2,"a":1,"c":3} 
               v2 det: {"a":1,"b":2,"c":3}
case match     v1: {UserName:x} 
               v2: {UserName:} 
duplicate      v1: {UserName:y} 
               v2: {UserName:x} ERR: jsontext: duplicate object member name "user_name"
bad utf-8      v1: "a�b" 
               v2: "" ERR: jsontext: invalid UTF-8 within "/user_name" after offset 15
unknown        v1: {UserName:x} 
               v2 reject: {UserName:x} ERR: json: cannot unmarshal JSON string into Go main.U: unknown object member name "extra"
```

| Behaviour | `encoding/json` (v1 semantics) | `encoding/json/v2` |
|---|---|---|
| nil slice / nil map | `null` | `[]` / `{}` (`FormatNilSliceAsNull(true)` restores `null`) |
| `omitempty` | omits `false`, `0`, nil, empty string, array, slice and map; keeps a struct | omits a value that **encodes as** `null`, `""`, `{}` or `[]`: keeps `0` and `false`, omits an empty struct |
| `omitzero` | zero value or `IsZero()` | same |
| Name matching on decode | case-insensitive | **case-sensitive** (`MatchCaseInsensitiveNames(true)` or the `case:ignore` tag option) |
| Duplicate names in an object | last one wins | **error** |
| Invalid UTF-8 in a string | replaced by U+FFFD | **error** |
| Unknown members | ignored | ignored by default; `RejectUnknownMembers(true)` makes them an error |
| Map key order when encoding | sorted | **not** sorted; `Deterministic(true)` sorts |
| `&`, `<`, `>` in strings | escaped as `&` and so on | **not** escaped; `jsontext.EscapeForHTML(true)` escapes them |
| `time.Duration` | integer nanoseconds | **error** (`no default representation`): supply a marshaler, see [[json-custom]] |
| `[N]byte` array | array of numbers | base64 string, like `[]byte` |

The options are plain function values you pass at the call: `jsonv2.Marshal(v,
jsonv2.Deterministic(true))`, combined with `jsonv2.JoinOptions`. To get the old semantics out of
v2, pass `json.DefaultOptionsV1()` (or single options such as
`json.FormatDurationAsNano(true)`) from the **`encoding/json`** package.

New or changed tag options in v2:

- **`embed`** promotes the fields of a struct field, a `jsontext.Value`, or a `map[string]T`
  into the parent object. With a `map` or `jsontext.Value` it collects **all unknown members**:
  a typed catch-all for extra keys.
- **`case:ignore`** or **`case:strict`** chooses name matching per field.
- **`omitzero`** and **`string`** work as in v1, although in v2 `string` is an error on a field
  that is not a number.

```go title="v2feat/main.go"
package main

import (
	"encoding/json"
	"encoding/json/jsontext"
	jsonv2 "encoding/json/v2"
	"fmt"
	"os"
	"time"
)

type Cfg struct {
	Name  string                    `json:"name"`
	Extra map[string]jsontext.Value `json:",embed"`
}

type Evt struct {
	ID   int64     `json:"id,string"`
	Time time.Time `json:"time,omitzero"`
	Tags []string  `json:"tags,omitempty"`
}

type Legacy struct {
	Items []string
	Wait  time.Duration
}

func main() {
	var c Cfg
	err := jsonv2.Unmarshal([]byte(`{"name":"x","a":1,"b":[true]}`), &c)
	fmt.Println(c.Name, len(c.Extra), string(c.Extra["b"]), err)
	out, _ := jsonv2.Marshal(c, jsonv2.Deterministic(true))
	fmt.Println(string(out))

	out, _ = jsonv2.Marshal(Evt{ID: 9007199254740993}, jsontext.Multiline(true), jsontext.WithIndent("  "))
	fmt.Println(string(out))

	// v1 semantics through v2 with options
	out, err = jsonv2.Marshal(Legacy{Wait: time.Second}, json.DefaultOptionsV1())
	fmt.Println(string(out), err)

	// streaming
	err = jsonv2.MarshalWrite(os.Stdout, map[string]int{"n": 1})
	fmt.Println(err)

	var v1err Evt
	err = json.Unmarshal([]byte(`{"id":"nope"}`), &v1err)
	fmt.Println(err)
	err = jsonv2.Unmarshal([]byte(`{"id":"nope"}`), &v1err)
	fmt.Println(err)
	err = json.Unmarshal([]byte(`{"id": 5}`), &v1err)
	fmt.Println(err)
	var x struct{ N int }
	err = json.Unmarshal([]byte(`{"N":"s"}`), &x)
	fmt.Println(err)
	err = json.Unmarshal([]byte(`{"N":1,}`), &x)
	fmt.Println(err)
	err = jsonv2.Unmarshal([]byte(`{"N":1,}`), &x)
	fmt.Println(err)
}
```

```text
x 2 [true] <nil>
{"name":"x","a":1,"b":[true]}
{
  "id": "9007199254740993"
}
{"Items":null,"Wait":1000000000} <nil>
{"n":1}<nil>
json: cannot unmarshal number nope into Go struct field Evt.id of type int64
json: cannot unmarshal JSON string "nope" into Go int64 within "/id": invalid syntax
json: cannot unmarshal number into Go struct field Evt.id of type int64
json: cannot unmarshal string into Go struct field .N of type int
invalid character '}' looking for beginning of object key string
jsontext: invalid character ',' at start of value after offset 6
```

The first two lines show `embed` collecting the unknown members `a` and `b` into `Extra` and
writing them back; the next block shows `jsontext.Multiline` and `WithIndent` for formatting;
`json.DefaultOptionsV1()` reproduces v1 output from the v2 function; and the last lines
compare error messages: for example, v2 names the JSON pointer (`"/id"`) where the failure
happened.

> [!NOTE]
> Features that existed during the v2 experiment (Go 1.25 and 1.26, behind
> `GOEXPERIMENT=jsonv2`) changed before 1.27 shipped: the `format` tag option (for example
> `format:RFC3339`) and the `unknown` tag option are **removed**, the `DiscardUnknownMembers`
> option and the `SkipFunc` sentinel error are removed, and the `inline` tag option is
> **renamed `embed`**. Code written against the experiment needs those edits.

**Which one to use.** Existing code: keep `encoding/json`; it behaves as before, only faster.
Code that needs strictness (reject duplicate names and bad UTF-8, case-sensitive keys), typed
catch-alls, or streaming through `jsontext`: use `encoding/json/v2`, and read its stricter
defaults as features for input from outside. This route uses `encoding/json` in the examples;
[[json-custom]] shows the v2 way of customising types.

linkcheck reads its JSON config file with a `Decoder` and `DisallowUnknownFields` in
[[step-5-filters]], writes its JSON report in [[step-7-reporters]], and saves state as
gzipped JSON in [[step-8-state]].
