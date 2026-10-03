---
title: Implicit satisfaction and small interfaces
done_when: "You can make a type satisfy an interface without naming it, add a compile-time check with `var _ I = (*T)(nil)`, and read the compiler's \"does not implement\" message."
---
An interface type is a set of method signatures. A type satisfies (implements) the
interface when its method set contains every one of those methods. There is no
`implements` keyword: satisfaction is implicit, checked by the compiler wherever a value
is assigned to the interface.

That one design choice changes where interfaces live. In Java or C# the type that
implements an interface must name it, so interfaces are declared next to the
implementation. In Go the type never mentions the interface, so the code that *needs* the
behaviour declares the interface, with only the methods it calls. A type written years
earlier, in a package you do not control, can satisfy an interface you declare today.

```go title="main.go"
package main

import (
	"fmt"
	"os"
	"strings"
)

// Notifier is defined by the code that uses it, not by the types that satisfy it.
type Notifier interface {
	Notify(msg string) error
}

type consoleNotifier struct {
	prefix string
}

func (c consoleNotifier) Notify(msg string) error {
	_, err := fmt.Println(c.prefix + msg)
	return err
}

type memoryNotifier struct {
	sent []string
}

func (m *memoryNotifier) Notify(msg string) error {
	m.sent = append(m.sent, msg)
	return nil
}

// stringWriter describes a method *strings.Builder and *os.File already have.
type stringWriter interface {
	WriteString(s string) (int, error)
}

// Compile-time checks: the build fails if a type stops satisfying the interface.
var (
	_ Notifier = consoleNotifier{}
	_ Notifier = (*memoryNotifier)(nil)
)

func broadcast(msg string, targets ...Notifier) {
	for _, t := range targets {
		if err := t.Notify(msg); err != nil {
			fmt.Println("notify failed:", err)
		}
	}
}

func main() {
	mem := &memoryNotifier{}
	broadcast("deploy finished", consoleNotifier{prefix: "[console] "}, mem)
	fmt.Println("memory got:", mem.sent)

	var sb strings.Builder
	for _, w := range []stringWriter{&sb, os.Stdout} {
		w.WriteString("hello from a type that never heard of stringWriter\n")
	}
	fmt.Print("builder holds: ", sb.String())
}
```

```bash
go run .
```

```text
[console] deploy finished
memory got: [deploy finished]
hello from a type that never heard of stringWriter
builder holds: hello from a type that never heard of stringWriter
```

## How it works

- `broadcast` accepts `...Notifier`. When you pass `consoleNotifier{...}` and `mem`, the
  compiler checks each argument's method set against `Notifier`'s one method, by name and
  exact signature. Both match, so both convert to `Notifier` values.
- `stringWriter` is declared in `main`. Neither `strings` nor `os` knows it exists, yet
  `*strings.Builder` and `*os.File` both have `WriteString(string) (int, error)`, so both
  satisfy it. This is why Go code can introduce an abstraction over existing types without
  editing them or writing adapters.
- `var _ Notifier = (*memoryNotifier)(nil)` declares a variable named `_` (discarded) of
  type `Notifier` and assigns a typed nil pointer to it. It costs nothing at run time; its
  only job is to make the compiler check the assignment. Use it when a type is meant to
  satisfy an interface but nothing in the package assigns it to one, for example a type
  only used by other packages.

## Method sets decide satisfaction

Which methods a type "has" depends on the receiver, as covered in [[method-sets]]: the
method set of `T` holds only value-receiver methods, while `*T` holds both. So a type with
a pointer-receiver method satisfies the interface only through a pointer. The signature
must also match exactly, including the results.

```go title="main.go"
package main

import "fmt"

type Notifier interface {
	Notify(msg string) error
}

type memoryNotifier struct {
	sent []string
}

func (m *memoryNotifier) Notify(msg string) error {
	m.sent = append(m.sent, msg)
	return nil
}

type silentNotifier struct{}

func (silentNotifier) Notify(msg string) {}

func main() {
	var n Notifier = memoryNotifier{}
	var s Notifier = silentNotifier{}
	fmt.Println(n, s)
}
```

```bash
go build .
```

```text
# example.com/implicit-bad
./main.go:23:19: cannot use memoryNotifier{} (value of struct type memoryNotifier) as Notifier value in variable declaration: memoryNotifier does not implement Notifier (method Notify has pointer receiver)
./main.go:24:19: cannot use silentNotifier{} (value of struct type silentNotifier) as Notifier value in variable declaration: silentNotifier does not implement Notifier (wrong type for method Notify)
		have Notify(string)
		want Notify(string) error
```

The first error is the one you will meet most. The fix is `&memoryNotifier{}`. The rule
exists for safety: a value stored in an interface is a copy, and the copy is not
addressable, so a pointer method called through the interface could only modify that
hidden copy. Go refuses rather than silently losing the update.

## Why small interfaces

The standard library's most used interfaces have one or two methods: `io.Reader`
(`Read`), `io.Writer` (`Write`), `fmt.Stringer` (`String`), `error` (`Error`),
`sort.Interface` (three). The fewer methods an interface demands, the more types satisfy
it and the easier it is to write a fake for a test. "The bigger the interface, the weaker
the abstraction" is a Go proverb for this reason.

| Choice | Consequence |
|---|---|
| One-method interface, declared by the caller | Many types fit; a test fake is a few lines |
| Large interface mirroring one struct | Only that struct fits; every fake must stub every method |
| Interface declared next to its only implementation | Usually premature; callers can declare their own |
| Methods named after the behaviour (`Notify`, `Read`) | One-method interfaces are named method + "er": `Notifier`, `Reader` |

> [!WARNING]
> Declaring a big interface "for testability" next to a struct, with every method of the
> struct, is the usual mistake. Symptom: each test fake grows to a dozen stub methods, and
> adding a method to the struct breaks every fake. Fix: let each consumer declare the one
> or two methods it calls. Implicit satisfaction means the struct needs no change.

You will build on this throughout the part: [[io-composition]] shows how far two
one-method interfaces go, and [[accept-interfaces]] turns it into an API rule.
