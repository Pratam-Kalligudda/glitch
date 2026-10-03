---
title: Embedding interfaces
done_when: "You can build a wider interface from small ones, wrap an io.Writer by embedding it in a struct, and say which methods the wrapper hides."
---
Embedding works in two places with interfaces, and they do different jobs:

1. **An interface embedded in an interface** builds a wider interface out of smaller ones.
   `io.ReadWriteCloser` is just `Reader`, `Writer` and `Closer` listed together. This is
   how Go keeps interfaces small without forcing callers to write long lists of methods.
2. **An interface embedded in a struct** gives the struct a field of interface type whose
   methods are promoted to the struct, as with any embedded field ([[structs-embedding]]).
   The struct then satisfies the interface by delegation, and can override some methods.
   This is how you write wrappers (decorators) and partial test fakes.

## Interfaces from interfaces

```go title="main.go"
package main

import (
	"fmt"
	"io"
	"strings"
)

// Small interfaces, each one behaviour.
type Getter interface {
	Get(key string) (string, bool)
}

type Putter interface {
	Put(key, value string)
}

// Store is the union of both method sets.
type Store interface {
	Getter
	Putter
}

// Closer-carrying interfaces may overlap: both embed io.Closer's Close() error.
type ReadStore interface {
	Getter
	io.Closer
}

type WriteStore interface {
	Putter
	io.Closer
}

type ReadWriteStore interface {
	ReadStore
	WriteStore // Close appears twice with identical signatures: allowed
}

type memStore struct {
	data map[string]string
}

func (m *memStore) Get(key string) (string, bool) {
	v, ok := m.data[key]
	return v, ok
}

func (m *memStore) Put(key, value string) {
	m.data[key] = value
}

func (m *memStore) Close() error {
	fmt.Println("closed")
	return nil
}

// lookup needs only Get, so it asks only for a Getter.
func lookup(g Getter, key string) string {
	v, ok := g.Get(key)
	if !ok {
		return key + ": missing"
	}
	return key + ": " + v
}

func main() {
	var rw ReadWriteStore = &memStore{data: map[string]string{}}
	rw.Put("lang", "go")

	var s Store = rw // a wider interface converts to a narrower one implicitly
	var g Getter = s // and again
	fmt.Println(lookup(g, "lang"))
	fmt.Println(lookup(g, "editor"))
	rw.Close()

	// The standard library builds its io interfaces the same way.
	var rc io.ReadCloser = io.NopCloser(strings.NewReader("data"))
	var r io.Reader = rc
	b, _ := io.ReadAll(r)
	fmt.Printf("%s via %T\n", b, r)
}
```

```bash
go run .
```

```text
lang: go
editor: missing
closed
data via io.nopCloserWriterTo
```

### How it works

- An interface's method set is the union of its own methods and those of every embedded
  interface. `ReadWriteStore` has `Get`, `Put` and `Close`.
- The same method may arrive by two paths (`Close` through `ReadStore` and `WriteStore`).
  Since Go 1.14 that is allowed as long as the signatures are identical; the method appears
  once. If the signatures differ, the declaration does not compile:

```go title="main.go"
package main

import "io"

type Resource interface {
	io.Closer
	Close() // different signature from io.Closer's Close() error
}

func main() {}
```

```text
./main.go:6:2: duplicate method Close
	./main.go:7:2: other declaration of method Close
```

- A value of a wider interface type is assignable to any narrower interface whose methods
  it has, with no conversion or assertion: `Store` to `Getter`, `io.ReadCloser` to
  `io.Reader`. Going the other way (narrow to wide) needs a type assertion, because the
  compiler cannot know the dynamic type has the extra methods.
- `%T` printed `io.nopCloserWriterTo`, not a "nopCloser". `io.NopCloser` returns a type
  that also has `WriteTo` when the wrapped reader does, so `io.Copy`'s capability check
  still finds the fast path. Keep that in mind for the next section.

## Interfaces inside structs

Embedding `io.Writer` in a struct promotes `Write`, so the struct is an `io.Writer` with no
code at all. Declaring your own `Write` overrides the promoted one; inside it you reach the
inner writer through the field, whose name is the type name, `c.Writer`.

```go title="main.go"
package main

import (
	"bufio"
	"fmt"
	"io"
	"os"
)

// countingWriter embeds an io.Writer. It gets Write for free through promotion,
// and overrides it to count bytes on the way through.
type countingWriter struct {
	io.Writer
	n int64
}

func (c *countingWriter) Write(p []byte) (int, error) {
	n, err := c.Writer.Write(p) // call the embedded writer explicitly
	c.n += int64(n)
	return n, err
}

// Store has two methods; a test fake may only care about one.
type Store interface {
	Get(key string) (string, bool)
	Put(key, value string)
}

// getOnlyFake embeds Store (left nil) and implements only Get.
type getOnlyFake struct {
	Store
}

func (getOnlyFake) Get(key string) (string, bool) { return "fake-" + key, true }

func main() {
	bw := bufio.NewWriter(os.Stdout)
	cw := &countingWriter{Writer: bw}
	fmt.Fprintln(cw, "hello through a wrapper")
	fmt.Println("bytes counted:", cw.n)

	// The wrapper's method set is Write only. Flush on the inner writer is hidden.
	var w io.Writer = cw
	_, canFlush := w.(interface{ Flush() error })
	fmt.Println("wrapper exposes Flush:", canFlush)
	bw.Flush() // you must flush the inner writer yourself

	var s Store = getOnlyFake{}
	v, _ := s.Get("lang")
	fmt.Println("Get:", v)
	fmt.Println("Put on the fake...")
	s.Put("lang", "go") // promoted from the nil embedded Store
}
```

```bash
go run .
```

```text
bytes counted: 24
wrapper exposes Flush: false
hello through a wrapper
Get: fake-lang
Put on the fake...
panic: runtime error: invalid memory address or nil pointer dereference

goroutine 1 [running]:
main.main()
```

The `[signal ...]` line of the panic is omitted; its text varies by operating system.

### How it works

- `countingWriter`'s method set comes from its declared methods plus the promoted methods
  of the *static* type of the embedded field, `io.Writer`. That is `Write` and nothing
  else. The dynamic value in the field is a `*bufio.Writer`, which also has `Flush`, but
  promotion is decided at compile time from the field's type. So the
  `interface{ Flush() error }` assertion fails, and "hello through a wrapper" appears only
  after the explicit `bw.Flush()`.
- `getOnlyFake{}` leaves its embedded `Store` nil. It still satisfies `Store`, because
  `Put` is promoted from the field's type. Calling `Put` calls `f.Store.Put`, a method call
  on a nil interface, which panics. This is useful in tests: a fake that embeds the
  interface compiles even as the interface grows, and any method the test did not expect
  to be called fails loudly.

> [!WARNING]
> A wrapper that embeds an interface hides every method of the wrapped value that is not
> in that interface. Symptom: a buffered writer behind your wrapper is never flushed, or
> `io.Copy` and `net/http` lose fast paths and optional features (`http.Flusher` on a
> wrapped `http.ResponseWriter` is the classic case). Fix: forward the optional methods
> you need explicitly (for example add `Flush` that asserts on the inner value), or keep
> a reference to the inner value and call it directly, as `bw.Flush()` does above.

> [!WARNING]
> Embedding an interface in a fake and forgetting to implement a method the code under
> test calls compiles fine and panics at run time with a nil pointer dereference. Read the
> stack trace: the failing frame is the promoted method you did not implement.

The partial-fake pattern returns in [[test-doubles]], where linkcheck's `Fetcher`
interface gets fakes for its tests.
