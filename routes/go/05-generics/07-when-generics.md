---
title: When to use generics
done_when: "Given a function, you can say whether it should be generic, an interface parameter, a function argument or concrete code, and give the reason."
---
Generics solve one problem: the same code for different types, with the types still
checked. They are not an abstraction tool for behaviour: Go already has interfaces for that
([[implicit-interfaces]]). Writing a type parameter when an interface or a plain type
would do makes code harder to read and no better. The Go blog's "When To Use Generics"
gives the same advice: start by writing functions, and add type parameters when you see
the same code repeated with only the types changed.

Here are the cases side by side in one program.

```go title="main.go"
package main

import (
	"fmt"
	"io"
	"os"
	"slices"
	"strings"
)

// Needless: W is only ever used through io.Writer's methods.
func Greet[W io.Writer](w W, name string) {
	fmt.Fprintf(w, "hello, %s\n", name)
}

// Better: an interface parameter says the same thing.
func GreetPlain(w io.Writer, name string) {
	fmt.Fprintf(w, "hello, %s\n", name)
}

// Good: the body is identical for every element type, and the result type
// depends on the input type. An interface could not express this.
func Filter[S ~[]E, E any](s S, keep func(E) bool) S {
	var out S
	for _, v := range s {
		if keep(v) {
			out = append(out, v)
		}
	}
	return out
}

// Smell: a type switch inside a generic function means the types are not
// interchangeable. Each case is a separate function.
func Describe[T any](v T) string {
	switch x := any(v).(type) {
	case int:
		return fmt.Sprintf("int %d", x)
	case string:
		return "string " + x
	default:
		return "unknown"
	}
}

func main() {
	Greet(os.Stdout, "a")
	GreetPlain(os.Stdout, "b")

	words := strings.Fields("go is a small language")
	short := Filter(words, func(s string) bool { return len(s) <= 2 })
	fmt.Println(short, slices.Equal(short, []string{"go", "is", "a"}))
	fmt.Println(Describe(1), Describe("x"), Describe(2.5))
}
```

```bash
go run .
```

```text
hello, a
hello, b
[go is a] true
int 1 string x unknown
```

## How to decide

**Use generics when the body is the same for every type.** `Filter` never looks at what an
element is: it copies values and calls a function. The type parameter's only job is to carry
the type from input to output, so the caller gets a `[]string` back, not a `[]any` to
assert. The `S ~[]E` form ([[inference]]) even keeps a caller's named slice type. This is the
case for:

- functions over slices, maps and channels that make no assumption about the element
  ([[slices-maps-pkgs]] is full of them);
- general-purpose containers such as a set, a stack or a cache ([[generic-types]]);
- helpers whose return type depends on an argument type, such as `Max` or `Index`.

**Use an interface when the behaviour differs by type.** `Greet` does nothing with `W`
except call `Write`. Its generic form says nothing the interface does not, and it adds
brackets for every reader. An interface parameter also takes a value of any type at run
time, which a type parameter does not. The Go blog adds that a type parameter will generally
not be faster than an interface here, so there is no performance reason either; measure
before you believe one ([[benchmarks]]).

**Use a function argument when only one operation varies.** If a caller can pass `less`,
`key` or `keep`, you need no constraint at all. `slices.SortFunc` takes the comparison as a
function for this reason, and the type's own ordering is not required.

**Use plain code when only one type exists.** A `Set[T]` with one use, with `string`,
is a `map[string]struct{}`. Write the concrete version first. When the second type arrives,
turn the first into a generic one, a mechanical change. The reverse, unpicking a premature
abstraction, is not.

**A type switch inside generic code is a smell.** `Describe` accepts `any` type and
branches on it, so the type parameter gives no safety: `Describe(2.5)` compiles and returns
`"unknown"`. The cases are separate behaviours. Write separate functions or use an
interface with a method.

| You are writing | Use |
|---|---|
| Same body, different element types | A type parameter |
| Same operation, different behaviour per type | An interface |
| One step differs, the caller knows it | A function argument |
| Behaviour depends on the concrete type | A type switch or interface, not `[T any]` |
| One caller, one type | Concrete code |
| Struct with a field of unknown type | A generic type if the field's type must be preserved, otherwise `any` |

## Costs to keep in mind

- **Readability.** A signature such as `func Map[S ~[]E, E, R any](s S, f func(E) R) []R`
  is harder to read than the concrete one. Every type parameter must pay for itself.
- **Public API.** A generic function in an exported package is an API commitment. Callers
  depend on its constraints; loosening one is compatible, tightening one is not.
- **Errors.** Compile errors in generic code read like those you saw in this part: they
  mention `T`, constraints and "does not satisfy". Keep constraints short and named so the
  messages stay legible.

> [!WARNING]
> Making a function generic "in case" is the most common misuse. Symptom: a type parameter
> list on every helper, constraints like `[T any]` with a type switch inside, and
> callers who must write `Foo[int]` because nothing infers `T`. Fix: delete the type
> parameter, pass an interface or a function, and add generics back only when you are copying
> the body for a second type.

> [!NOTE]
> Before writing a generic helper, check the standard library: `slices`, `maps`, `cmp`
> and `iter` already cover most of what one writes by hand; see
> [[slices-maps-pkgs]].

linkcheck uses generics in two places, the `Set[T]` of visited URLs in
[[step-2-crawl]] and a few small helpers such as `Sorted` and `Filter` in
[[step-7-reporters]], and interfaces everywhere else ([[implicit-interfaces]]).
