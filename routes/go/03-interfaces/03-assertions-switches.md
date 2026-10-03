---
title: Type assertions and type switches
done_when: "You can extract a concrete value from an interface with comma-ok, test for an optional method with an interface assertion, and order type switch cases so the right one wins."
---
An interface value hides its dynamic type. A **type assertion** `x.(T)` gets it back: it
checks at run time that the interface `x` is not nil and that its dynamic type is `T` (or,
when `T` is itself an interface, that the dynamic type implements `T`). A **type switch**
runs that check against several types in one statement. You need both when one code path
must treat some types differently, and to discover optional behaviour that a value may or
may not have.

```go title="main.go"
package main

import (
	"errors"
	"fmt"
	"time"
)

func describe(v any) string {
	switch x := v.(type) {
	case nil:
		return "nil interface"
	case int:
		return fmt.Sprintf("int, doubled: %d", x*2) // x is int
	case string:
		return fmt.Sprintf("string of %d bytes", len(x)) // x is string
	case int8, int16, int32, int64:
		return fmt.Sprintf("sized int %v (x has type any here; dynamic type %T)", x, x)
	case error:
		return "error: " + x.Error() // x is error
	case fmt.Stringer:
		return "stringer: " + x.String() // x is fmt.Stringer
	default:
		return fmt.Sprintf("unhandled %T", x)
	}
}

func main() {
	values := []any{nil, 21, "héllo", int64(7), errors.New("disk full"), 90 * time.Second, 3.5}
	for _, v := range values {
		fmt.Println(describe(v))
	}

	var v any = "42"
	n, ok := v.(int)
	fmt.Printf("comma-ok: n=%d ok=%t\n", n, ok)

	s := v.(string)
	fmt.Println("single-value assertion that holds:", s)

	fmt.Println("single-value assertion that fails:")
	n = v.(int)
	fmt.Println(n)
}
```

```bash
go run .
```

```text
nil interface
int, doubled: 42
string of 6 bytes
sized int 7 (x has type any here; dynamic type int64)
error: disk full
stringer: 1m30s
unhandled float64
comma-ok: n=0 ok=false
single-value assertion that holds: 42
single-value assertion that fails:
panic: interface conversion: interface {} is string, not int

goroutine 1 [running]:
main.main()
```

## How it works

**Assertions.** `v.(int)` has two forms:

- Single value, `n := v.(int)`: if the assertion fails, it panics with an `interface
  conversion` message naming both types, as in the last line above.
- Comma-ok, `n, ok := v.(int)`: never panics. On failure `ok` is false and `n` is the
  zero value of `int`. Use this form whenever failure is possible; keep the single-value
  form for cases where a failure means a bug.

When `T` is a concrete type, the assertion asks "is the dynamic type exactly `T`?". A
defined type such as `time.Duration` does not match `int64`, even though its underlying
type is `int64`. The compiler also rejects assertions that can never succeed: on an
`io.Writer` (the one-method interface behind `os.Stdout`, covered in [[io-composition]]),
`w.(string)` fails to build with:

```text
impossible type assertion: w.(string)
	string does not implement io.Writer (missing method Write)
```

**Type switches.** `switch x := v.(type)` evaluates `v` once, then tests the cases in
order and runs the first that matches. The variable `x` takes a different type in each
clause:

| Case | Type of `x` in the clause |
|---|---|
| exactly one type, `case int:` | that type, `int` |
| an interface, `case error:` | that interface, `error` |
| several types, `case int8, int16:` | the switch expression's type, here `any` |
| `case nil:` | the switch expression's type; matches only the nil interface value |
| `default:` | the switch expression's type |

So in the `int8, int16, int32, int64` clause `x` is still `any`, and arithmetic on it does
not compile:

```text
invalid operation: x * 2 (mismatched types any and untyped int)
```

When you need the concrete type, give each type its own case. `fallthrough` is not allowed
in a type switch. `case nil` matches only a nil interface; an interface holding a nil
pointer goes to that pointer type's case, the trap from [[interface-values]].

## Asserting to an interface: optional capabilities

Asserting to an interface type is how Go code asks "does this value also do X?" without
widening the interface it accepts. The standard library does this constantly: `io.Copy`
checks whether the source has `WriteTo`, `fmt` checks for `String` and `Error`. Here a
report writer flushes the writer only if it buffers:

```go title="main.go"
package main

import (
	"bufio"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
)

// flusher is an optional capability. Some writers buffer, some do not.
type flusher interface {
	Flush() error
}

func writeReport(w io.Writer, lines []string) error {
	for _, l := range lines {
		if _, err := fmt.Fprintln(w, l); err != nil {
			return err
		}
	}
	// Assert to an interface: does the dynamic type also have Flush?
	if f, ok := w.(flusher); ok {
		fmt.Fprintf(os.Stderr, "(%T can flush, flushing)\n", w)
		return f.Flush()
	}
	fmt.Fprintf(os.Stderr, "(%T has no Flush)\n", w)
	return nil
}

// timeoutError implements both error and fmt.Stringer.
type timeoutError struct{}

func (timeoutError) Error() string  { return "timed out" }
func (timeoutError) String() string { return "timeoutError{}" }

func kind(v any) string {
	switch v.(type) {
	case fmt.Stringer:
		return "Stringer"
	case error:
		return "error"
	}
	return "other"
}

func main() {
	lines := []string{"ok  /", "404 /missing"}

	bw := bufio.NewWriter(os.Stdout)
	writeReport(bw, lines)

	var sb strings.Builder
	writeReport(&sb, lines)
	fmt.Print(sb.String())

	// The first matching case wins, so order interface cases from specific to general.
	fmt.Println("timeoutError matched as:", kind(timeoutError{}))
	fmt.Println("errors.New matched as:", kind(errors.New("x")))
}
```

```bash
go run .
```

```text
(*bufio.Writer can flush, flushing)
ok  /
404 /missing
(*strings.Builder has no Flush)
ok  /
404 /missing
timeoutError matched as: Stringer
errors.New matched as: error
```

The `*bufio.Writer` line on stderr appears before the report lines: the buffered writer
held them until `Flush`. A plain `*strings.Builder` has no `Flush`, so the assertion
reports `ok == false` and the code skips it.

`kind` shows why order matters. `timeoutError` satisfies both `fmt.Stringer` and `error`,
and the switch picks the first matching case, `fmt.Stringer`. Unlike concrete types,
interface cases can overlap, and the compiler does not warn you.

> [!WARNING]
> Two common mistakes. First, the single-value form `v.(T)` on data you do not control
> (decoded JSON, values from a `map[string]any`): symptom, a `panic: interface conversion`
> in production on unexpected input; fix, use comma-ok and handle `!ok`. Second, putting a
> broad interface case (`error`, `fmt.Stringer`, `any`) above a narrower one: symptom, the
> narrower clause never runs; fix, list concrete types first, then narrow interfaces, then
> broad ones.

> [!NOTE]
> For errors, do not type-assert directly: `err.(*MyError)` misses an error that has been
> wrapped. [[is-as]] covers `errors.As` and `errors.AsType`, which search the whole chain.
