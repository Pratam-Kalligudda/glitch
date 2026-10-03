---
title: Wrapping errors
done_when: "Your errors read as one line from the operation down to the cause, errors.Unwrap walks back down that chain, and you can say when you chose %v over %w on purpose."
---
An error from deep in a call stack ("i/o timeout") is useless on its own: which request,
which page, which run? Each layer that returns the error should add the context it knows.
**Wrapping** does that without losing the original: the new error carries a message *and*
a reference to the error it wraps, its **cause**. The chain of causes is the **error
chain** (strictly a tree, once one error wraps several). Callers can then print the whole
story and still ask questions about the root cause.

`fmt.Errorf` with the `%w` verb is the everyday way to wrap.

```go title="main.go"
package main

import (
	"errors"
	"fmt"
)

var errTimeout = errors.New("i/o timeout")

func fetch(url string) error {
	return fmt.Errorf("get %s: %w", url, errTimeout)
}

func crawl(depth int) error {
	if err := fetch("https://go.dev/doc"); err != nil {
		return fmt.Errorf("crawl depth %d: %w", depth, err)
	}
	return nil
}

func run() error {
	if err := crawl(2); err != nil {
		return fmt.Errorf("run: %w", err)
	}
	return nil
}

// crawlOpaque formats with %v: same text, but the chain is cut.
func crawlOpaque() error {
	if err := fetch("https://go.dev/doc"); err != nil {
		return fmt.Errorf("crawl: %v", err)
	}
	return nil
}

func main() {
	err := run()
	fmt.Println("message:", err)

	fmt.Println("chain:")
	for e := err; e != nil; e = errors.Unwrap(e) {
		fmt.Printf("  %-20T %q\n", e, e.Error())
	}
	fmt.Println("is errTimeout:", errors.Is(err, errTimeout))
	fmt.Println("err == errTimeout:", err == errTimeout)

	opaque := crawlOpaque()
	fmt.Println("opaque message:", opaque)
	fmt.Println("opaque unwraps to:", errors.Unwrap(opaque))
	fmt.Println("opaque is errTimeout:", errors.Is(opaque, errTimeout))
}
```

```bash
go run .
```

```text
message: run: crawl depth 2: get https://go.dev/doc: i/o timeout
chain:
  *fmt.wrapError       "run: crawl depth 2: get https://go.dev/doc: i/o timeout"
  *fmt.wrapError       "crawl depth 2: get https://go.dev/doc: i/o timeout"
  *fmt.wrapError       "get https://go.dev/doc: i/o timeout"
  *errors.errorString  "i/o timeout"
is errTimeout: true
err == errTimeout: false
opaque message: crawl: get https://go.dev/doc: i/o timeout
opaque unwraps to: <nil>
opaque is errTimeout: false
```

## How it works

- `fmt.Errorf("get %s: %w", url, errTimeout)` formats the message exactly as `%v` would,
  and because the format has a `%w` with an error operand, it returns a value (here a
  `*fmt.wrapError`) that also stores that operand and has a method `Unwrap() error`
  returning it.
- `errors.Unwrap(e)` calls `e.Unwrap()` if `e` has that method, and returns `nil`
  otherwise. The loop walks the chain one layer at a time until it reaches the
  `*errors.errorString` from `errors.New`, which wraps nothing.
- Each layer's message contains the layer below it, so printing the outermost error prints
  the whole chain: `run: crawl depth 2: get https://go.dev/doc: i/o timeout`.
- `err == errTimeout` is false: the outer error is a different value. `errors.Is` walks
  the chain and compares each layer, so it finds `errTimeout`. Never compare a returned
  error with `==` unless the function documents that it returns the value unwrapped;
  [[is-as]] covers `errors.Is` in full.
- `crawlOpaque` used `%v`. The message is identical, but the result has no `Unwrap`
  method, so the cause is gone. That is not always a mistake; see below.

## Your own wrapper type

`fmt.Errorf` adds text. When the context is data a caller might want (a URL, an attempt
number, a status code), put it in a struct and give the struct an `Unwrap` method. The
standard library does this with `*fs.PathError`, `*url.Error` and `*net.OpError`.

```go title="main.go"
package main

import (
	"errors"
	"fmt"
)

var (
	errTimeout = errors.New("i/o timeout")
	errRetries = errors.New("retries exhausted")
)

// FetchError adds structured context and wraps a cause.
type FetchError struct {
	URL     string
	Attempt int
	Err     error
}

func (e *FetchError) Error() string {
	return fmt.Sprintf("fetch %s (attempt %d): %v", e.URL, e.Attempt, e.Err)
}

// Unwrap exposes the cause to errors.Unwrap, errors.Is and errors.As.
func (e *FetchError) Unwrap() error { return e.Err }

func fetch(url string) error {
	return &FetchError{URL: url, Attempt: 3, Err: errTimeout}
}

func main() {
	err := fmt.Errorf("check links: %w", fetch("https://go.dev/doc"))
	fmt.Println(err)
	for e := err; e != nil; e = errors.Unwrap(e) {
		fmt.Printf("  %T\n", e)
	}
	fmt.Println("is errTimeout:", errors.Is(err, errTimeout))

	// Two %w verbs: the result wraps both and has Unwrap() []error.
	both := fmt.Errorf("give up: %w after %w", errRetries, errTimeout)
	fmt.Println(both)
	fmt.Printf("type %T, errors.Unwrap: %v\n", both, errors.Unwrap(both))
	fmt.Println("is errRetries:", errors.Is(both, errRetries), " is errTimeout:", errors.Is(both, errTimeout))
	if m, ok := both.(interface{ Unwrap() []error }); ok {
		fmt.Println("children:", len(m.Unwrap()))
	}
}
```

```text
check links: fetch https://go.dev/doc (attempt 3): i/o timeout
  *fmt.wrapError
  *main.FetchError
  *errors.errorString
is errTimeout: true
give up: retries exhausted after i/o timeout
type *fmt.wrapErrors, errors.Unwrap: <nil>
is errRetries: true  is errTimeout: true
children: 2
```

The chain now mixes kinds: a `fmt` wrapper, your `*FetchError`, and the sentinel at the
bottom. Anything with an `Unwrap() error` method is a link in the chain; nothing else is
required.

With more than one `%w` (allowed since Go 1.20), `fmt.Errorf` returns a
`*fmt.wrapErrors` whose method is `Unwrap() []error`. `errors.Unwrap` only calls the
single-error form, so it returns `nil` here, while `errors.Is` and `errors.As` search
every branch. That is why the chain is really a tree. [[join]] covers this form in depth.

## Wrap or not

Wrapping makes the cause part of your function's contract: once callers write
`errors.Is(err, sql.ErrNoRows)` against your function, you can no longer switch to a
different database without breaking them.

| Use | When |
|---|---|
| `%w` | The caller may reasonably act on the cause: a timeout to retry, `fs.ErrNotExist` to create the file, a context cancellation to stop |
| `%v` | The cause is an implementation detail you may change; you still want its text in the message |
| A new error, no cause text | The cause would leak something callers must not see, such as a SQL query or a secret |

[[error-design]] turns this into rules for a whole package.

> [!WARNING]
> Three wrapping mistakes. First, `%w` with a non-error operand, such as a string:
> `fmt.Errorf("load: %w", "file missing")` prints `load: %!w(string=file missing)` and
> wraps nothing; `go vet` reports `fmt.Errorf format %w has arg "file missing" of wrong
> type string`. Second, wrapping without checking: `return fmt.Errorf("load: %w", err)`
> when `err` may be nil returns a *non-nil* error with the message `load: %!w(<nil>)`.
> Always wrap inside `if err != nil`. Third, repeating context each layer already adds:
> `fetch: fetch https://...: fetch failed: ...`. Each layer adds only what it knows that
> the layer below does not, usually the operation and its arguments.

> [!NOTE]
> Go 1.27's `go vet` also flags `%w` with a pointer to a value-receiver error type, a bug
> covered in [[sentinel-typed]].

linkcheck's `LinkError` in [[step-2-crawl]] wraps the underlying network error or
`ErrBadStatus` the way `FetchError` does here, with an `Unwrap` method.
