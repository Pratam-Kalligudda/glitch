---
title: Strings, bytes and runes
---
A Go `string` is an immutable sequence of **bytes**. Not characters: bytes. By convention,
and in every string literal you write, those bytes are **UTF-8**, the encoding in which
one character takes one to four bytes. A **rune** is Go's name for a Unicode code point,
one "character" in the everyday sense; the type `rune` is an alias for `int32`. Knowing
which of the three you are holding (a byte, a rune, or a string of bytes) explains why
`len("é")` is 2, why indexing a string gives you a number, and why cutting a string at a
byte offset can corrupt it.

## One string, three views

```go title="main.go"
package main

import (
	"fmt"
	"unicode/utf8"
)

func main() {
	s := "héllo, 世界"
	fmt.Println(len(s), utf8.RuneCountInString(s))

	fmt.Println(s[1], string(s[1]), s[1:3])

	for i, r := range s {
		fmt.Printf("%d:%c(%U) ", i, r, r)
	}
	fmt.Println()

	b := []byte(s)
	r := []rune(s)
	fmt.Println(len(b), len(r), string(r[7:]))
	fmt.Printf("% x\n", s[:3])

	bad := "ok\xffok"
	fmt.Println(utf8.ValidString(bad))
	for i, r := range bad {
		fmt.Printf("%d:%q ", i, r)
	}
	fmt.Println()

	fmt.Println(s[:2], utf8.ValidString(s[:2]))

	b[0] = 'H'
	fmt.Println(string(b), s)
}
```

```bash
go run .
```

```text
14 9
195 Ã é
0:h(U+0068) 1:é(U+00E9) 3:l(U+006C) 4:l(U+006C) 5:o(U+006F) 6:,(U+002C) 7: (U+0020) 8:世(U+4E16) 11:界(U+754C) 
14 9 世界
68 c3 a9
false
0:'o' 1:'k' 2:'�' 3:'o' 4:'k' 
h� false
Héllo, 世界 héllo, 世界
```

## How it works

**`len` counts bytes.** `"héllo, 世界"` has 9 characters but 14 bytes: `é` is 2 bytes
(`c3 a9`), each of `世` and `界` is 3. `utf8.RuneCountInString` counts runes.

**Indexing gives a byte.** `s[1]` is `195` (`0xc3`), the first byte of `é`, of type `byte`
(an alias for `uint8`). `string(s[1])` converts that number to the rune U+00C3, which is
`Ã`: a different character. Indexing is byte-based because it is O(1); finding the n-th
rune requires decoding everything before it.

**Slicing works on byte offsets.** `s[1:3]` is the two bytes of `é`, so it prints `é`.
`s[:2]` is `h` plus half of `é`: not valid UTF-8, printed as `h�`.

**`range` over a string decodes runes.** Each iteration yields the **byte offset** where the
rune starts and the rune itself. The offsets jump 1, 3, 8, 11 because the runes before them
were wider than one byte. When `range` meets bytes that are not valid UTF-8, it yields
`utf8.RuneError` (U+FFFD, printed `�`) and advances one byte, so a `range` loop never
stops or panics on bad input.

**Conversions copy.** `[]byte(s)` and `[]rune(s)` allocate new slices; `string(b)` and
`string(r)` allocate new strings. A string is immutable, so the conversion must copy:
otherwise changing the byte slice would change the string. `b[0] = 'H'` changed `b`, and
`s` still starts with `h`. (The compiler removes the copy in some cases it can prove safe,
such as `m[string(b)]` lookups and comparisons.)

A string value is a two-word header, a pointer to the bytes and a length, like a slice
without the capacity. Assigning or passing a string copies the header, never the bytes, and
because the bytes can never change, sharing them is safe. Substrings share the original's
bytes too, so `s[i:j]` is cheap.

| You want | Use | Unit |
|---|---|---|
| Size in bytes | `len(s)` | byte |
| Number of characters | `utf8.RuneCountInString(s)` | rune |
| The i-th byte | `s[i]` | `byte` |
| Each character | `for i, r := range s` | `rune`, with byte offset `i` |
| A mutable copy | `[]byte(s)` | byte |
| Random access by character | `[]rune(s)` | rune (4 bytes each) |
| Check encoding | `utf8.ValidString(s)` | |

What the compiler and vet say about the common confusions:

```go title="e/e.go"
package e

import "fmt"

func errors() {
	s := "hello"
	s[0] = 'H'
	code := 65
	fmt.Println(string(code))
}
```

```text
# example.com/strs/e
e\e.go:7:2: cannot assign to s[0] (neither addressable nor a map index expression)
```

Delete the two lines that use `s` and it compiles, and `go vet` catches the conversion:

```text
e\e.go:7:14: conversion from int to string yields a string of one rune, not a string of digits
```

`string(65)` is `"A"`, not `"65"`. Use `strconv.Itoa(65)` for digits (see [[strconv]]).

## Truncating text, and building it

```go title="trunc/main.go"
package main

import (
	"fmt"
	"strings"
	"unicode/utf8"
)

// truncateBytes cuts s to at most n bytes: wrong for non-ASCII text.
func truncateBytes(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "..."
}

// truncate cuts s to at most n runes, never splitting a character.
func truncate(s string, n int) string {
	i := 0
	for pos := range s {
		if i == n {
			return s[:pos] + "..."
		}
		i++
	}
	return s
}

func main() {
	title := "Prüfung der Links"
	fmt.Println(truncateBytes(title, 3), utf8.ValidString(truncateBytes(title, 3)))
	fmt.Println(truncate(title, 3))

	var sb strings.Builder
	for i := range 3 {
		fmt.Fprintf(&sb, "link %d;", i)
	}
	fmt.Println(sb.String(), sb.Len())
}
```

```text
Pr�... false
Prü...
link 0;link 1;link 2; 21
```

`truncate` ranges over the string to find rune boundaries, then slices at a byte offset
that is known to be one. No allocation beyond the result.

`strings.Builder` collects pieces into one growing byte buffer and turns it into a string
without a final copy. Building a string with `s += piece` in a loop copies everything
built so far on every iteration, which is quadratic. `fmt.Fprintf(&sb, ...)` works because
`*strings.Builder` is an `io.Writer` (see [[io-composition]]).

> [!WARNING]
> Cutting a string at a fixed byte count, `s[:n]`, splits multi-byte characters. The
> symptom is a `�` at the end of truncated titles, or invalid UTF-8 that a JSON encoder or
> database rejects, and only for non-English text, so English-only tests pass. Cut at a rune
> boundary, as `truncate` does, or use `[]rune(s)[:n]` when the string is short and the extra
> allocation does not matter. `len(s) > 80` is a byte check; use
> `utf8.RuneCountInString(s) > 80` when you mean characters.

> [!NOTE]
> Even a rune is not always what a reader calls a character: `é` can also be written as `e`
> followed by a combining accent, two runes. Comparing such strings needs Unicode
> normalisation, in `golang.org/x/text/unicode/norm`. The full story is in the Go blog post
> <https://go.dev/blog/strings>. The `strings`, `unicode` and `utf8` packages are covered in
> [[strings-pkg]] and [[unicode-utf8]].

The page text linkcheck reads from the web is arbitrary UTF-8; keep these rules in mind when
its reporters format it in [[step-7-reporters]].
