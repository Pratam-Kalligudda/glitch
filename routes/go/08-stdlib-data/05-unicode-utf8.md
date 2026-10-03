---
title: unicode and utf8
---
A Go string holds bytes. The convention (and what the compiler and `range` assume) is that
those bytes are UTF-8, an encoding where each **code point** takes one to four bytes. Go
calls a code point a **rune** (the type `rune` is `int32`). [[strings-runes]] introduced the
idea; this stop covers the two packages that work with it: `unicode/utf8` counts, decodes
and validates the encoding, and `unicode` classifies runes (letter, digit, space, script).

## Counting, decoding, encoding

```go title="a/main.go"
package main

import (
	"fmt"
	"unicode"
	"unicode/utf8"
)

func main() {
	s := "Go, 世界! é"
	fmt.Println(len(s), utf8.RuneCountInString(s), utf8.ValidString(s))

	for i, r := range s {
		fmt.Printf("%d:%c(%d) ", i, r, utf8.RuneLen(r))
	}
	fmt.Println()

	r, size := utf8.DecodeRuneInString("世界")
	fmt.Printf("%c %d\n", r, size)
	r, size = utf8.DecodeLastRuneInString("世界")
	fmt.Printf("%c %d\n", r, size)

	buf := make([]byte, 4)
	n := utf8.EncodeRune(buf, '€')
	fmt.Println(buf[:n], n)
	fmt.Println(utf8.AppendRune([]byte("x"), 'é'))

	fmt.Println(utf8.RuneError, utf8.UTFMax, utf8.MaxRune)

	for _, c := range []rune{'a', 'Z', '5', ' ', '世', 'é', '٣', '!'} {
		fmt.Printf("%c letter=%t upper=%t digit=%t space=%t punct=%t\n", c,
			unicode.IsLetter(c), unicode.IsUpper(c), unicode.IsDigit(c), unicode.IsSpace(c), unicode.IsPunct(c))
	}
	fmt.Println(string(unicode.ToUpper('é')), string(unicode.ToLower('Ä')), unicode.IsOneOf([]*unicode.RangeTable{unicode.Han, unicode.Latin}, '世'))
	fmt.Println(unicode.Is(unicode.Han, '世'), unicode.In('é', unicode.Latin, unicode.Greek))
}
```

```bash
go run ./a
```

```text
14 9 true
0:G(1) 1:o(1) 2:,(1) 3: (1) 4:世(3) 7:界(3) 10:!(1) 11: (1) 12:é(2) 
世 3
界 3
[226 130 172] 3
[120 195 169]
65533 4 1114111
a letter=true upper=false digit=false space=false punct=false
Z letter=true upper=true digit=false space=false punct=false
5 letter=false upper=false digit=true space=false punct=false
  letter=false upper=false digit=false space=true punct=false
世 letter=true upper=false digit=false space=false punct=false
é letter=true upper=false digit=false space=false punct=false
٣ letter=false upper=false digit=true space=false punct=false
! letter=false upper=false digit=false space=false punct=true
É ä true
true true
```

What this shows:

- `len(s)` is **bytes** (14), `utf8.RuneCountInString(s)` is **runes** (9). `世` takes three
  bytes, `é` two.
- `for i, r := range s` decodes one rune at a time: `i` is the byte index where the rune
  starts, so indexes jump (`4`, `7`, `10`).
- `DecodeRuneInString` returns the first rune and its size in bytes; `DecodeLastRuneInString`
  the last. `EncodeRune` writes a rune into a byte slice and returns the number of bytes,
  `AppendRune` appends it. `utf8.UTFMax` is 4.
- `utf8.RuneError` is `U+FFFD` (65533), the replacement character.

The `unicode` predicates take a rune: `IsLetter`, `IsDigit`, `IsNumber`, `IsSpace`, `IsUpper`,
`IsLower`, `IsPunct`, `IsControl`, `IsSymbol`, `IsPrint`, `IsGraphic`. They follow Unicode,
not ASCII: `世` and `é` are letters, and the Arabic-Indic digit `٣` is a digit (`IsDigit`
is true), so `unicode.IsDigit` is wrong for validating an ASCII number such as a port; compare
with `'0' <= c && c <= '9'` instead. `ToUpper`, `ToLower` and `ToTitle` map one rune to one rune.

For scripts and categories use range tables: `unicode.Is(unicode.Han, r)` tests one table,
`unicode.In(r, unicode.Latin, unicode.Greek)` tests several. `unicode.Scripts` and
`unicode.Categories` map names to tables. Go 1.27 uses Unicode 17.0.0 (`unicode.Version`);
before it, the tables were Unicode 15.

## Invalid UTF-8

A Go string can hold any bytes, including ones that are not valid UTF-8 (a Latin-1 file, a
truncated read, hostile input). `range` and the `utf8` functions do not fail on them; they
produce `RuneError`.

```go title="b/main.go"
package main

import (
	"fmt"
	"unicode/utf8"
)

func main() {
	bad := "ab\xffcd"
	fmt.Println(len(bad), utf8.ValidString(bad), utf8.RuneCountInString(bad))
	for i, r := range bad {
		fmt.Printf("%d:%U ", i, r)
	}
	fmt.Println()
	r, size := utf8.DecodeRuneInString(bad[2:])
	fmt.Println(r == utf8.RuneError, size)

	// An actual U+FFFD in the text also has size 3:
	r, size = utf8.DecodeRuneInString("�")
	fmt.Println(r == utf8.RuneError, size)

	fmt.Printf("%q\n", string([]rune(bad)))
	fmt.Printf("% x\n", string([]rune(bad)))
}
```

```text
5 false 5
0:U+0061 1:U+0062 2:U+FFFD 3:U+0063 4:U+0064 
true 1
true 3
"ab�cd"
61 62 ef bf bd 63 64
```

The byte `0xff` can never appear in UTF-8, so `range` yields `U+FFFD` for it and advances **one**
byte. `DecodeRuneInString` returns `(RuneError, 1)` for invalid input. A real `U+FFFD` in the
text decodes as `(RuneError, 3)`, so to tell an error from a genuine replacement character check
the size is 1, or call `utf8.ValidString` first. Converting to `[]rune` and back replaces each
invalid byte with the three bytes `ef bf bd` (UTF-8 for `U+FFFD`): lossy, and now valid.

## Slicing text safely

Indexing and slicing work on bytes, so they can cut a character in half:

```go title="c/main.go"
package main

import (
	"fmt"
	"strings"
	"unicode/utf8"
)

func main() {
	s := "héllo"
	fmt.Printf("%q %d %t\n", s[:2], len(s[:2]), utf8.ValidString(s[:2]))
	fmt.Println(strings.ToValidUTF8(s[:2], "?"))

	// truncate on a rune boundary
	n := 2
	for n > 0 && !utf8.RuneStart(s[n]) {
		n--
	}
	fmt.Println(s[:n])

	// reverse by runes
	rs := []rune("héllo, 世界")
	for i, j := 0, len(rs)-1; i < j; i, j = i+1, j-1 {
		rs[i], rs[j] = rs[j], rs[i]
	}
	fmt.Println(string(rs))

	// composed vs decomposed é
	a, b := "é", "é"
	fmt.Println(a == b, len(a), len(b), utf8.RuneCountInString(b), a, b)
}
```

```text
"h\xc3" 2 false
h?
h
界世 ,olléh
false 2 3 2 é é
```

`s[:2]` of `héllo` keeps `h` and only the first byte of `é`: a broken string (`ValidString`
is false, and `%q` shows the stray byte as `\xc3`). Repairs and safe versions:

- `strings.ToValidUTF8(s, "?")` replaces invalid runs with the string you give.
- `utf8.RuneStart(b)` is true for a byte that begins a character, so step back from your cut
  point until it is true to truncate at a rune boundary.
- Convert to `[]rune` to reverse or index by character. This allocates four bytes per rune.

The last lines show a subtler fact: `é` can be one rune (`U+00E9`) or two (`e` plus the combining
accent `U+0301`). They look identical and are not `==`. A rune is a code point, not what a
reader sees as one character (a **grapheme cluster**). The standard library has no grapheme
segmentation, nor normalisation; for comparing user-entered text that must match, use
`golang.org/x/text/unicode/norm`.

> [!WARNING]
> Truncating a string by byte count (`s[:80]` for a "short description") corrupts any
> multi-byte text at the cut. Symptom: a `�` at the end of a title, or a database or JSON
> encoder rejecting the value. Fix: cut at a rune boundary as above, or count runes, and
> remember that even rune counts do not match what readers see for combined characters.

| Task | Use |
|---|---|
| Characters in a string | `utf8.RuneCountInString(s)`, not `len(s)` |
| Is this text valid UTF-8? | `utf8.ValidString(s)`, `utf8.Valid(b)` |
| First or last rune and its size | `utf8.DecodeRuneInString`, `utf8.DecodeLastRuneInString` |
| Rune to bytes | `utf8.AppendRune(b, r)`, `utf8.EncodeRune(p, r)` |
| Is a byte the start of a rune? | `utf8.RuneStart(b)` |
| Letter / digit / space test | `unicode.IsLetter`, `unicode.IsDigit`, `unicode.IsSpace` |
| Script or category test | `unicode.Is(unicode.Han, r)`, `unicode.In(r, tables...)` |
| Replace invalid bytes | `strings.ToValidUTF8(s, "?")` |

linkcheck's reporters in [[step-7-reporters]] print URLs and error text from the web, which
can hold any UTF-8; these checks apply to anything you print from outside.
