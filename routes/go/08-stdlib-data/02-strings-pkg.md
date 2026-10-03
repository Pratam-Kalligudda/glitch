---
title: The strings package
---
A Go string is an immutable sequence of bytes ([[strings-runes]]), and the `strings` package
is the toolbox for it: search, split, trim, replace, build. Nearly all text handling in
a command-line tool is these dozen functions. The package never modifies a string; every
function returns a new one (or a slice of the old one, which costs nothing).

## Search and slice

```go title="a/main.go"
package main

import (
	"fmt"
	"strings"
)

func main() {
	s := "https://go.dev/doc/install.html?lang=en"

	fmt.Println(strings.Contains(s, "go.dev"), strings.HasPrefix(s, "https://"), strings.HasSuffix(s, ".html"))
	fmt.Println(strings.Index(s, "/"), strings.LastIndex(s, "/"), strings.Index(s, "zzz"))
	fmt.Println(strings.Count(s, "/"), strings.Count("abc", ""))

	before, after, found := strings.Cut(s, "?")
	fmt.Println(before, after, found)

	dir, file, ok := strings.CutLast(before, "/")
	fmt.Println(dir, file, ok)

	rest, ok := strings.CutPrefix(s, "https://")
	fmt.Println(rest, ok)
	_, ok = strings.CutSuffix(s, ".pdf")
	fmt.Println(ok)

	// Old way for CutLast
	i := strings.LastIndex(before, "/")
	fmt.Println(before[:i], before[i+1:])
}
```

```bash
go run ./a
```

```text
true true false
6 18 -1
4 4
https://go.dev/doc/install.html lang=en true
https://go.dev/doc install.html true
go.dev/doc/install.html?lang=en true
false
https://go.dev/doc install.html
```

`Index` and `LastIndex` return the byte offset, or `-1` when the text is absent. Always
check for `-1` before slicing with the result: `s[:-1]` is a compile error for a constant
but a runtime panic for a variable.

**`Cut` replaces most `Index`-then-slice code.** `strings.Cut(s, sep)` returns the text
before the first `sep`, the text after it and whether `sep` was found. When it is not found
you get `s, "", false`. `CutPrefix` and `CutSuffix` strip a prefix or suffix and say
whether they did, which replaces a `HasPrefix` followed by `s[len(prefix):]`.

**`CutLast` (Go 1.27)** cuts at the last separator, so splitting a path or URL into
directory and file is one line. Before 1.27 you wrote the `LastIndex` form that the last
line of the example shows, with the `-1` check you need to remember. `bytes.CutLast` is the
same for byte slices.

## Splitting and joining

```go title="b/main.go"
package main

import (
	"fmt"
	"strings"
)

func main() {
	fmt.Printf("%q\n", strings.Split("a,b,,c", ","))
	fmt.Printf("%q\n", strings.Split("", ","))
	fmt.Printf("%q\n", strings.Split("abc", ""))
	fmt.Printf("%q\n", strings.SplitN("a,b,c,d", ",", 2))
	fmt.Printf("%q\n", strings.SplitAfter("a,b,c", ","))
	fmt.Printf("%q\n", strings.Fields("  go   is\tfun\n "))
	fmt.Printf("%q\n", strings.FieldsFunc("a1b22c", func(r rune) bool { return r >= '0' && r <= '9' }))
	fmt.Printf("%q\n", strings.Join([]string{"a", "b", "c"}, "-"))

	for part := range strings.SplitSeq("x=1;y=2;z=3", ";") {
		fmt.Print("[", part, "] ")
	}
	fmt.Println()
	for f := range strings.FieldsSeq("  one two  three ") {
		fmt.Print("[", f, "] ")
	}
	fmt.Println()
	for line := range strings.Lines("first\nsecond\r\nthird") {
		fmt.Printf("%q ", line)
	}
	fmt.Println()
}
```

```text
["a" "b" "" "c"]
[""]
["a" "b" "c"]
["a" "b,c,d"]
["a," "b," "c"]
["go" "is" "fun"]
["a" "b" "c"]
"a-b-c"
[x=1] [y=2] [z=3] 
[one] [two] [three] 
"first\n" "second\r\n" "third" 
```

| Function | Behaviour |
|---|---|
| `Split(s, sep)` | Every piece, empty ones included. `Split("", ",")` is one empty string, not none |
| `Split(s, "")` | Splits into UTF-8 characters |
| `SplitN(s, sep, n)` | At most `n` pieces; the last holds the remainder. `n < 0` means all, `n == 0` means `nil` |
| `SplitAfter(s, sep)` | Like `Split`, keeping `sep` at the end of each piece |
| `Fields(s)` | Splits around runs of white space and drops empty pieces: right for human-written text |
| `FieldsFunc(s, f)` | Same, with your own definition of a separator |
| `Join(elems, sep)` | The inverse of `Split` |
| `SplitSeq`, `SplitAfterSeq`, `FieldsSeq`, `FieldsFuncSeq`, `Lines` | The same, as iterators (Go 1.24) |

The `Seq` functions return an `iter.Seq[string]` that you range over ([[range-func]]). They
do not allocate the slice of pieces, so use them when you only loop over the result or stop
early. `Lines` yields each line **with** its line terminator (`"second\r\n"` above), so
trim it if you do not want it.

> [!NOTE]
> `Split` keeps empty pieces, which surprises people reading `a,,b`: you get three items.
> `Fields` never returns an empty item. Choose by what an empty piece means in your data.

## Trimming

```go title="c/main.go"
package main

import (
	"fmt"
	"strings"
)

func main() {
	fmt.Printf("%q\n", strings.TrimSpace("\t hi \n"))
	fmt.Printf("%q\n", strings.Trim("xxhixx", "x"))
	fmt.Printf("%q\n", strings.TrimLeft("abcabc-go", "abc"))
	fmt.Printf("%q\n", strings.TrimPrefix("abcabc-go", "abc"))
	fmt.Printf("%q\n", strings.TrimSuffix("file.go.go", ".go"))
	fmt.Printf("%q\n", strings.TrimFunc("123abc456", func(r rune) bool { return r < 'a' }))

}
```

```text
"hi"
"hi"
"-go"
"abc-go"
"file.go"
"abc"
```

`TrimSpace` removes Unicode white space at both ends. `TrimPrefix` and `TrimSuffix` remove
one exact string, once. The `Trim`, `TrimLeft` and `TrimRight` functions take a **cutset**:
a set of characters, not a string. `TrimLeft("abcabc-go", "abc")` removes every leading
`a`, `b` or `c`, leaving `-go`, while `TrimPrefix("abcabc-go", "abc")` removes the prefix
once and leaves `abc-go`.

> [!WARNING]
> Using `TrimLeft`/`Trim` to strip a prefix such as `"https://"` or a suffix such as `".go"`
> is the classic `strings` bug. Symptom: it works on your test input and eats extra
> characters on another (`TrimLeft("assets/a.css", "as")` gives `"ets/a.css"`
> where `TrimPrefix` gives `"sets/a.css"`). Fix: `TrimPrefix`/`TrimSuffix`, or `CutPrefix` when you also need to know
> whether it was there.

## Replacing, mapping and comparing

```go title="d/main.go"
package main

import (
	"fmt"
	"strings"
	"unicode"
)

func main() {
	fmt.Println(strings.Replace("oink oink oink", "k", "ky", 2))
	fmt.Println(strings.ReplaceAll("oink oink oink", "oink", "moo"))
	r := strings.NewReplacer("<", "&lt;", ">", "&gt;", "&", "&amp;")
	fmt.Println(r.Replace("a < b && c > d"))
	fmt.Println(strings.NewReplacer("a", "b", "b", "a").Replace("abba"))

	fmt.Println(strings.ToUpper("straße"), strings.ToLower("ÀÉÎ"), strings.ToTitle("go"))
	fmt.Println(strings.EqualFold("Go", "GO"), "Go" == "GO")
	fmt.Println(strings.Map(func(r rune) rune {
		if unicode.IsSpace(r) {
			return -1
		}
		return unicode.ToUpper(r)
	}, "a b c"))
	fmt.Println(strings.Repeat("=-", 5))
	fmt.Println(strings.Compare("a", "b"), strings.ContainsAny("hello", "xyz"), strings.ContainsRune("hello", 'l'))
	fmt.Println(strings.IndexByte("golang", 'l'), strings.IndexAny("golang", "ng"), strings.IndexFunc("go1", unicode.IsDigit))
}
```

```text
oinky oinky oink
moo moo moo
a &lt; b &amp;&amp; c &gt; d
baab
STRAßE àéî GO
true false
ABC
=-=-=-=-=-
-1 false true
2 0 2
```

`Replace(s, old, new, n)` replaces the first `n` occurrences; `ReplaceAll` replaces every
one. A `strings.Replacer` makes many replacements in **one pass** and is safe for
concurrent use. It never rescans replaced text, which is why swapping `a` and `b` works
(`abba` becomes `baab`) where two `ReplaceAll` calls would not. Build it once and reuse it.

Case handling is Unicode-aware but not language-aware. `ToUpper("straße")` gives `STRAßE`
because Go uses the simple one-to-one mapping and `ß` has none. For case-insensitive
comparison use `EqualFold`, not `ToLower(a) == ToLower(b)`: it compares by Unicode simple
folding without allocating. `Map` applies a function to every rune and drops runes for which
it returns a negative value.

`Contains`, `ContainsAny`, `ContainsRune`, `IndexByte`, `IndexAny` and `IndexFunc` cover the
other searches. Use `==`, `<` and `>` to compare strings; `strings.Compare` exists but the
operators are clearer (and `cmp.Compare` handles generic code, see [[compare-sort]]).

## Building strings

Concatenating with `+=` in a loop copies the whole string every time, so the work grows with
the square of the output size. `strings.Builder` appends into one growing buffer and copies
once at the end.

```go title="e/main.go"
package main

import (
	"fmt"
	"io"
	"strings"
)

func main() {
	var b strings.Builder
	for i := range 3 {
		fmt.Fprintf(&b, "line %d\n", i)
	}
	b.WriteString("done")
	b.WriteByte('!')
	b.WriteRune('é')
	fmt.Println(b.Len())
	fmt.Println(b.String())

	r := strings.NewReader("hello world")
	buf := make([]byte, 5)
	n, _ := r.Read(buf)
	fmt.Println(n, string(buf), r.Len())
	rest, _ := io.ReadAll(r)
	fmt.Printf("%q\n", rest)
}
```

```text
28
line 0
line 1
line 2
done!é
5 hello 6
" world"
```

A `Builder` is ready as the zero value. It implements `io.Writer`, so `fmt.Fprintf(&b, ...)`
writes into it, and `String()` returns the result without copying. `Len` and `Grow(n)` let you
preallocate when you know the size ([[pools-builders]]). `strings.NewReader` goes the other
way: it wraps a string as an `io.Reader`, `io.ByteReader` and `io.Seeker`, which is how you
feed a string to any function that reads, such as `bufio.Scanner` or `json.NewDecoder`.

A Builder must not be copied after first use:

```go title="f/main.go"
package main

import (
	"fmt"
	"strings"
)

func main() {
	var a strings.Builder
	a.WriteString("x")
	b := a // copies the Builder
	b.WriteString("y")
	fmt.Println(b.String())
}
```

```text
panic: strings: illegal use of non-zero Builder copied by value
```

> [!WARNING]
> Copying a `Builder` (assigning it, or passing it by value) after you have written to it
> panics with `illegal use of non-zero Builder copied by value`. The check exists because
> two copies would share one buffer and corrupt each other. Fix: pass `*strings.Builder`
> or keep the builder in one place and return its `String()`.

linkcheck uses `Cut` to split the `--rate` value in [[step-4-polite]], and `ToLower` and
`TrimSpace` to normalise URLs in [[step-2-crawl]].
