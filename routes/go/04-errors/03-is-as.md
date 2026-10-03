---
title: errors.Is, errors.As and errors.AsType
done_when: "You test wrapped errors with errors.Is for values and errors.AsType (or errors.As) for types, never with == or a direct type assertion, and go vet is clean."
---
Once errors are wrapped ([[wrapping]]), the error a caller receives is rarely the one that
caused the failure. `err == fs.ErrNotExist` and `err.(*fs.PathError)` look only at the
outermost layer, so they fail on a wrapped error. The `errors` package provides functions
that search the whole chain:

- **`errors.Is(err, target)`** reports whether any error in the chain *is* `target`: a
  question about a **value**, such as "is this a not-found error?".
- **`errors.As(err, &target)`** finds the first error in the chain of `target`'s type and
  stores it in `target`: a question about a **type**, such as "is there a `*fs.PathError`,
  and what path did it name?".
- **`errors.AsType[E](err)`** (Go 1.26) asks the same question as `As` and returns the
  error and a bool, with the type checked at compile time.

```go title="main.go"
package main

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
)

var ErrNotFound = errors.New("not found")

// StatusError reports an HTTP status. It matches ErrNotFound when the status is 404.
type StatusError struct {
	URL  string
	Code int
}

func (e *StatusError) Error() string {
	return fmt.Sprintf("%s: status %d", e.URL, e.Code)
}

// Is lets errors.Is(err, ErrNotFound) succeed for a 404 without wrapping ErrNotFound.
func (e *StatusError) Is(target error) bool {
	return target == ErrNotFound && e.Code == 404
}

func check(url string, code int) error {
	return fmt.Errorf("check %s: %w", url, &StatusError{URL: url, Code: code})
}

// timeouter is any error that can say whether it was a timeout.
type timeouter interface {
	error
	Timeout() bool
}

func main() {
	// 1. errors.Is: is this value (or a match) anywhere in the chain?
	_, err := os.Open("no-such-file.txt")
	err = fmt.Errorf("load config: %w", err)
	fmt.Println("Is fs.ErrNotExist:", errors.Is(err, fs.ErrNotExist))
	fmt.Println("Is ErrNotFound (404):", errors.Is(check("/old", 404), ErrNotFound))
	fmt.Println("Is ErrNotFound (500):", errors.Is(check("/api", 500), ErrNotFound))

	// 2. errors.As: find an error of a type, and get it as that type.
	var pathErr *fs.PathError
	if errors.As(err, &pathErr) {
		fmt.Printf("As *fs.PathError: op=%q path=%q\n", pathErr.Op, pathErr.Path)
	}

	// 3. errors.AsType (Go 1.26): the same search, returning the value.
	if se, ok := errors.AsType[*StatusError](check("/old", 404)); ok {
		fmt.Printf("AsType *StatusError: url=%s code=%d\n", se.URL, se.Code)
	}

	// 4. Target an interface: the first error in the chain with a Timeout method.
	if t, ok := errors.AsType[timeouter](err); ok {
		fmt.Printf("AsType timeouter: %T, timeout=%t\n", t, t.Timeout())
	}
}
```

```bash
go run .
```

```text
Is fs.ErrNotExist: true
Is ErrNotFound (404): true
Is ErrNotFound (500): false
As *fs.PathError: op="open" path="no-such-file.txt"
AsType *StatusError: url=/old code=404
AsType timeouter: *fs.PathError, timeout=false
```

## How errors.Is works

`errors.Is(err, target)` visits `err`, then the errors it wraps, and so on: through
`Unwrap() error` one at a time, and through `Unwrap() []error` depth-first, each child and
its whole subtree before the next child. At each error it reports a match if either:

1. the error `== target` (tried only when the target's type is comparable, so it never
   panics; sentinel errors made with `errors.New` are pointers and compare by identity),
   or
2. the error has a method `Is(error) bool` and `Is(target)` returns true.

The second rule is how `os.Open`'s error matches `fs.ErrNotExist`. The chain is your
`*fmt.wrapError`, then a `*fs.PathError`, then the operating system's error code
(`syscall.Errno`). That code is not `fs.ErrNotExist`, but `syscall.Errno` has an `Is`
method that maps "file not found" codes to it, on Windows and Unix alike. `StatusError`
uses the same trick: a 404 answers yes to `ErrNotFound` without wrapping it. An `Is` method
should compare only the receiver with the target; it must not unwrap, because `errors.Is`
does that.

## How errors.As and errors.AsType work

`errors.As(err, &target)` walks the same tree in the same order. At each error it checks
whether the error's dynamic type is assignable to `target`'s type; at the first match, it
stores the error in `target` and returns true. An error can also provide an `As(any) bool`
method to match types it is not. `target` must be a non-nil pointer to a type that
implements `error`, or to any interface type; otherwise `As` panics.

`errors.AsType[*StatusError](err)` does the same search. The type in square brackets is a
type argument (generics are covered in [[type-parameters]]): it names the type to look
for, and the function returns a value of that type and a bool. Compared with `As`, it:

- needs no separately declared variable, so the result is scoped to the `if`;
- checks the type at compile time: it must implement `error`;
- is faster, as the Go 1.26 release notes say: it uses plain type assertions where
  `errors.As` uses reflection.

Because of the compile-time rule, an interface target for `AsType` must include `error`,
as `timeouter` does. `errors.As` also accepts interfaces without `error`, such as
`interface{ Timeout() bool }`. Use `AsType` in new code unless you need that.

| Question | Use | Not |
|---|---|---|
| Is the cause this sentinel value? | `errors.Is(err, fs.ErrNotExist)` | `err == fs.ErrNotExist` |
| Is there an error of this type, and what are its fields? | `errors.AsType[*fs.PathError](err)` | `err.(*fs.PathError)` |
| Does any error in the chain have this method? | `errors.AsType[timeouter](err)` | a type switch on `err` |
| Is it exactly what the function returned, unwrapped? | `==` only if the function documents that it never wraps (as `io.EOF` from `Read`) | |

## Getting the target type wrong

`StatusError` has a pointer-receiver `Error` method, so the chain holds a `*StatusError`.
Asking for the value type `StatusError` is a bug. With `errors.As` it compiles, then
panics:

```go title="main.go"
package main

import (
	"errors"
	"fmt"
)

type StatusError struct {
	Code int
}

func (e *StatusError) Error() string { return fmt.Sprintf("status %d", e.Code) }

func main() {
	err := fmt.Errorf("check: %w", &StatusError{Code: 404})

	var se StatusError // value type, but the chain holds *StatusError
	fmt.Println(errors.As(err, &se))
}
```

```bash
go run .
```

```text
panic: errors: *target must be interface or implement error

goroutine 1 [running]:
```

`go vet` (and therefore `go test`) catches it before it runs:

```text
main.go:18:14: second argument to errors.As must be a non-nil pointer to either a type that implements error, or to any interface type
```

With `errors.AsType[StatusError](err)` the same mistake does not compile:

```text
./main.go:17:26: StatusError does not satisfy error (method Error has pointer receiver)
```

> [!WARNING]
> Checking a returned error with `==` or a type assertion works until someone adds
> context with `%w` one layer down, then silently stops matching. Symptom: retry or
> fallback code that never triggers, `os.IsNotExist(err)` returning false for a missing
> file (the old `os.Is*` helpers do not unwrap). Fix: `errors.Is` for values,
> `errors.AsType` for types, always. And name the type exactly as it is stored: if
> `Error` has a pointer receiver, look for `*T`.

> [!NOTE]
> The search returns the *first* match in depth-first order. If the chain contains two
> `*StatusError` values, `AsType` returns the outer one. To collect all of them, walk the
> tree yourself with `Unwrap() error` and `Unwrap() []error`.

linkcheck uses `errors.Is(err, context.Canceled)` to tell Ctrl-C from real failures in
[[step-3-concurrent]], and `errors.AsType[*LinkError]` to read the cause of a failure in its reports.
