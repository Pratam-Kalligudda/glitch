---
title: Accept interfaces, return structs
done_when: "Your functions take the narrowest interface they call (often io.Writer), your constructors return concrete pointer types, and a test can pass a fake in a few lines."
---
"Accept interfaces, return structs" is the Go rule of thumb for API shape. It follows
directly from implicit satisfaction ([[implicit-interfaces]]):

- **Accept interfaces.** A parameter typed as the smallest interface the function calls
  lets any type with those methods be passed: a file, a buffer, a network connection, a
  fake in a test. The function also documents exactly what it uses.
- **Return structs.** A result typed as a concrete type (usually a pointer to a struct)
  gives the caller every method and field, and lets you add methods later without
  breaking anyone. If a caller needs an interface, it can declare one; your concrete type
  will satisfy it with no change.

The interface belongs to the consumer, not the producer.

```go title="main.go"
package main

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"os"
)

// statusGetter is the one behaviour Checker needs. It is declared here, by the consumer,
// and it is unexported: callers never have to name it.
type statusGetter interface {
	Status(url string) (int, error)
}

// Result is a plain struct: callers can read every field.
type Result struct {
	URL    string
	Status int
	Err    error
}

// Checker is returned as a concrete type, so it can grow methods without breaking anyone.
type Checker struct {
	getter  statusGetter
	checked int
}

func NewChecker(g statusGetter) *Checker {
	return &Checker{getter: g}
}

func (c *Checker) Check(urls []string) []Result {
	results := make([]Result, 0, len(urls))
	for _, u := range urls {
		code, err := c.getter.Status(u)
		results = append(results, Result{URL: u, Status: code, Err: err})
		c.checked++
	}
	return results
}

func (c *Checker) Checked() int { return c.checked }

// WriteText accepts the smallest interface it needs: anything that can Write.
func WriteText(w io.Writer, results []Result) error {
	for _, r := range results {
		var err error
		if r.Err != nil {
			_, err = fmt.Fprintf(w, "ERR %s: %v\n", r.URL, r.Err)
		} else {
			_, err = fmt.Fprintf(w, "%3d %s\n", r.Status, r.URL)
		}
		if err != nil {
			return err
		}
	}
	return nil
}

// mapGetter is a fake: a map of canned answers. It satisfies statusGetter implicitly.
type mapGetter map[string]int

func (m mapGetter) Status(url string) (int, error) {
	code, ok := m[url]
	if !ok {
		return 0, errors.New("no such host")
	}
	return code, nil
}

func main() {
	c := NewChecker(mapGetter{
		"https://go.dev/":     200,
		"https://go.dev/nope": 404,
	})
	results := c.Check([]string{"https://go.dev/", "https://go.dev/nope", "https://bad.invalid/"})

	// The same function writes to the terminal and to memory.
	if err := WriteText(os.Stdout, results); err != nil {
		fmt.Fprintln(os.Stderr, err)
	}
	var buf bytes.Buffer
	WriteText(&buf, results)
	fmt.Printf("buffer: %d bytes, checker saw %d URLs\n", buf.Len(), c.Checked())
}
```

```bash
go run .
```

```text
200 https://go.dev/
404 https://go.dev/nope
ERR https://bad.invalid/: no such host
buffer: 83 bytes, checker saw 3 URLs
```

## How it works

- `WriteText` takes `io.Writer`, not `*os.File`. It only calls `Write` (through
  `fmt.Fprintf`), so asking for more would only shrink the set of callers. The same code
  writes to `os.Stdout` and to a `bytes.Buffer`; in a test you compare the buffer's
  contents with the expected text, with no files involved.
- `Checker` depends on `statusGetter`, a one-method interface it declares itself. In
  production you pass a type that makes HTTP requests; in this program a `map` type with a
  `Status` method stands in. The fake is six lines because the interface has one method.
- `NewChecker` returns `*Checker`. The caller can call `Checked`, which is not part of any
  interface, and any method you add next year. Nothing outside the package has to change.

## What returning an interface costs

Here the producer declares an interface next to its only implementation and returns it:

```go title="main.go"
package main

import "fmt"

// Cache is declared by the producer, next to its only implementation.
type Cache interface {
	Get(key string) (string, bool)
	Set(key, value string)
}

type memCache struct {
	data map[string]string
}

func (m *memCache) Get(key string) (string, bool) {
	v, ok := m.data[key]
	return v, ok
}

func (m *memCache) Set(key, value string) { m.data[key] = value }

// Len was added later. Callers holding a Cache cannot see it.
func (m *memCache) Len() int { return len(m.data) }

func NewCache() Cache {
	return &memCache{data: map[string]string{}}
}

func main() {
	c := NewCache()
	c.Set("a", "1")
	fmt.Println(c.Len())
}
```

```bash
go build .
```

```text
# example.com/returniface
./main.go:32:16: c.Len undefined (type Cache has no field or method Len)
```

To expose `Len` you must add it to `Cache`, and adding a method to an exported interface
breaks every other type that implemented it, including every test fake. The interface has
locked the API. Returning an interface also invites the nil trap from
[[interface-values]]: a constructor that returns a nil `*memCache` as a `Cache` hands the
caller a non-nil value. Returning `*memCache` (exported as, say, `*MemCache`) avoids both.

| Situation | Return |
|---|---|
| One implementation (the usual case) | The concrete type, usually a pointer |
| Failure | `error`, always the interface, never `*MyError` |
| The implementation is chosen at run time, or must stay hidden | An interface: `sha256.New()` returns `hash.Hash`, `io.MultiReader` returns `io.Reader` |
| The function wraps its argument and adds nothing new | The same interface it accepted, as `io.LimitReader` does |

> [!WARNING]
> The common mistake is writing the interface first, in the producer package, "so it can
> be mocked", and returning it from the constructor. Symptoms: every new method is a
> breaking change, fakes must implement methods the test never calls, and readers jump to
> an interface instead of the code. Fix: return the concrete type and let each consumer
> declare the narrow interface it needs, unexported if only that package uses it.

> [!NOTE]
> Accepting an interface has a small cost: a call through an interface cannot usually be
> inlined, and values passed in may be moved to the heap ([[escape-analysis]] shows how to
> see this). For I/O-bound code it never matters. In a hot loop over millions of values it
> can; measure before deciding.

linkcheck follows this rule throughout: the crawler accepts a `Fetcher` interface so
[[step-6-tests]] can swap in fakes, and every report format takes an `io.Writer` in
[[step-7-reporters]].
