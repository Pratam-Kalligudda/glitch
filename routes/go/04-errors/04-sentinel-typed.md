---
title: Sentinel errors and error types
done_when: "You can choose between a sentinel and an error type for a failure, return each so that errors.Is and errors.AsType find it, and go vet (Go 1.27) reports no %w pointer problems."
---
A caller that only prints an error needs nothing but its message. A caller that must
*react* (return 404, retry later, create the missing file) needs a way to recognise the
failure. Go has two standard shapes for recognisable errors:

- A **sentinel error** is a package-level variable holding one error value, such as
  `io.EOF`, `fs.ErrNotExist` or `sql.ErrNoRows`. It says *what* happened and nothing more.
  Callers test for it with `errors.Is`.
- An **error type** is a type, usually a struct, whose values implement `error`, such as
  `*fs.PathError` or `*strconv.NumError`. It says what happened *and carries data* about
  it. Callers find it with `errors.AsType` (or `errors.As`) and read its fields.

```go title="main.go"
package main

import (
	"errors"
	"fmt"
	"time"
)

// Sentinel errors: fixed values callers compare against with errors.Is.
var (
	ErrNotFound   = errors.New("store: not found")
	ErrReadOnly   = errors.New("store: read-only")
	errCorruption = errors.New("store: corrupt record") // unexported: not part of the API
)

// QuotaError is an error type: it carries data the caller can use.
type QuotaError struct {
	Used, Limit int
	RetryAfter  time.Duration
}

func (e *QuotaError) Error() string {
	return fmt.Sprintf("store: quota exceeded (%d/%d), retry after %v", e.Used, e.Limit, e.RetryAfter)
}

type Store struct {
	data     map[string]string
	readOnly bool
	writes   int
	limit    int
}

func (s *Store) Get(key string) (string, error) {
	v, ok := s.data[key]
	if !ok {
		return "", fmt.Errorf("get %q: %w", key, ErrNotFound)
	}
	return v, nil
}

func (s *Store) Put(key, value string) error {
	if s.readOnly {
		return ErrReadOnly
	}
	if s.writes >= s.limit {
		return &QuotaError{Used: s.writes, Limit: s.limit, RetryAfter: 30 * time.Second}
	}
	s.writes++
	s.data[key] = value
	return nil
}

func handle(err error) string {
	if err == nil {
		return "ok"
	}
	if errors.Is(err, ErrNotFound) {
		return "404: " + err.Error()
	}
	if errors.Is(err, ErrReadOnly) {
		return "503: maintenance"
	}
	if qe, ok := errors.AsType[*QuotaError](err); ok {
		return fmt.Sprintf("429: Retry-After %.0f", qe.RetryAfter.Seconds())
	}
	return "500: " + err.Error()
}

func main() {
	s := &Store{data: map[string]string{}, limit: 1}
	fmt.Println(handle(s.Put("a", "1")))
	fmt.Println(handle(s.Put("b", "2")))
	_, err := s.Get("zzz")
	fmt.Println(handle(err))
	s.readOnly = true
	fmt.Println(handle(s.Put("c", "3")))
	fmt.Println(handle(errCorruption))
}
```

```bash
go run .
```

```text
ok
429: Retry-After 30
404: get "zzz": store: not found
503: maintenance
500: store: corrupt record
```

## How it works

- `errors.New` returns a pointer to a new, private struct each time it is called. Two
  calls with the same text produce two different errors that are not `==`. A sentinel is
  therefore identified by *which variable* it came from, never by its text. Callers must
  not match on `err.Error()` strings: messages change; variables do not.
- `Get` wraps `ErrNotFound` with the key. `errors.Is` still finds it, and the message
  gains context. `Put` returns `ErrReadOnly` bare; both are fine because callers use
  `errors.Is` either way ([[is-as]]).
- `QuotaError` carries `RetryAfter`. A sentinel could not: there is one `ErrNotFound`
  value for the whole program, so it cannot hold per-call data. When the caller needs
  data, use a type.
- `errCorruption` is unexported. Callers cannot name it, so they cannot depend on it; it
  only produces a message. Export a sentinel or type only when you want callers to branch
  on it, because from then on it is part of your API.
- Naming: sentinels are `ErrSomething` (`errSomething` unexported); types are
  `SomethingError`. The message starts with the package name (`store: ...`) when the error
  may surface far from its origin.

| | Sentinel | Error type |
|---|---|---|
| Declared as | `var ErrX = errors.New("pkg: x")` | `type XError struct{...}` with `Error() string` |
| Carries data | No | Yes, in fields |
| Caller checks with | `errors.Is(err, pkg.ErrX)` | `errors.AsType[*pkg.XError](err)` |
| Typical use | Expected outcomes: end of input, not found, closed | Failures with details: path, line number, status code, retry delay |
| Standard library examples | `io.EOF`, `fs.ErrNotExist`, `context.Canceled` | `*fs.PathError`, `*strconv.NumError`, `*url.Error` |

A third shape, an **error behaviour**, lets callers ask a question without knowing the
type: any error with a `Timeout() bool` method, for example. You saw one searched for with
`errors.AsType[timeouter]` in [[is-as]]; `net.Error` is the standard library's version.

## Pointer or value receiver for an error type

An error type's `Error` method can have a pointer receiver (`func (e *QuotaError)`) or a
value receiver (`func (e QuotaError)`). Either works, as long as you then *return and
wrap* the same form every time, because `errors.AsType` and `errors.Is` compare dynamic
types exactly:

| `Error` receiver | Return / wrap | Callers search for |
|---|---|---|
| pointer `(e *T)` | `&T{...}` | `errors.AsType[*T]` |
| value `(e T)` | `T{...}` | `errors.AsType[T]` |

A pointer receiver is the common choice for structs: copying the struct into each
interface is avoided, and only `*T` implements `error`, so the value form cannot be
returned by accident. With a value receiver, both `T` and `*T` implement `error` (the
pointer's method set includes value methods, [[method-sets]]), and that makes this bug
possible:

```go title="main.go"
package main

import (
	"errors"
	"fmt"
)

// ParseError has a value receiver, so ParseError itself implements error.
type ParseError struct {
	Line int
}

func (e ParseError) Error() string { return fmt.Sprintf("parse error on line %d", e.Line) }

func parse() error {
	e := ParseError{Line: 7}
	return fmt.Errorf("load config: %w", &e) // wraps a *ParseError
}

func main() {
	err := parse()
	fmt.Println(err)

	pe, ok := errors.AsType[ParseError](err)
	fmt.Println("AsType[ParseError]: ", pe, ok)

	ppe, ok := errors.AsType[*ParseError](err)
	fmt.Println("AsType[*ParseError]:", ppe, ok)

	fmt.Println("errors.Is(err, ParseError{7}):", errors.Is(err, ParseError{Line: 7}))
}
```

```bash
go run .
```

```text
load config: parse error on line 7
AsType[ParseError]:  parse error on line 0 false
AsType[*ParseError]: parse error on line 7 true
errors.Is(err, ParseError{7}): false
```

The message looks right, so nothing seems wrong. But callers who follow the package's
design (value receiver, so search for `ParseError`) never find it: the chain holds a
`*ParseError`, a different type. `errors.Is` with a `ParseError` value fails for the same
reason. Since Go 1.27, `go vet`'s printf check reports exactly this pattern:

```bash
go vet .
```

```text
main.go:17:34: %w wants operand of error type ParseError, not pointer type *ParseError (defeats errors.Is)
```

The fix is `fmt.Errorf("load config: %w", e)`, wrapping the value.

> [!WARNING]
> Mixing the pointer and value forms of an error type. Symptom: `errors.AsType` or
> `errors.Is` returns false although the printed message shows the right error, so
> special handling (retry, 404) silently never runs. Fix: pick one form per type,
> preferably a pointer receiver, and always return and wrap that form; run `go vet`
> (Go 1.27 catches the `%w` case).

> [!WARNING]
> Returning a concrete error type from a function, `func parse() *ParseError`, brings back
> the nil trap from [[interface-values]]: a nil `*ParseError` assigned to `error` is not
> nil. Always declare the result as `error`.

> [!NOTE]
> A sentinel is a `var`, so in principle any code could reassign `io.EOF`. Nobody does,
> and the standard library accepts that risk. If you want an immutable sentinel, a
> constant of a string type works: `type constErr string`, a value-receiver `Error`
> method, and `const ErrX constErr = "pkg: x"`. Errors with the same text are then equal,
> which is usually what you want for a constant.

linkcheck defines a `*LinkError` type with the URL and the status, plus a cause it wraps, in
[[step-2-crawl]]. The page a link was found on is kept in the `Result`, not in the error.
