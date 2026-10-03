---
title: bytes and bytes.Buffer
---
The `bytes` package mirrors `strings` for `[]byte`. Files, sockets and `io.Reader`s hand you
bytes, and converting each chunk to a string just to search it copies the data, so `bytes`
offers the same functions without the conversion. It also has the type you will use most
from it: `bytes.Buffer`, an in-memory, growable byte buffer that is both an `io.Reader` and
an `io.Writer`.

## The functions

```go title="a/main.go"
package main

import (
	"bytes"
	"fmt"
)

func main() {
	b := []byte("Content-Type: text/html; charset=utf-8")

	fmt.Println(bytes.Contains(b, []byte("html")), bytes.HasPrefix(b, []byte("Content")))
	fmt.Println(bytes.Index(b, []byte(":")), bytes.Equal([]byte("a"), []byte("a")))
	fmt.Println(bytes.Compare([]byte("a"), []byte("b")))

	k, v, ok := bytes.Cut(b, []byte(": "))
	fmt.Printf("%s | %s | %v\n", k, v, ok)
	dir, file, _ := bytes.CutLast([]byte("a/b/c.txt"), []byte("/"))
	fmt.Printf("%s %s\n", dir, file)

	fmt.Printf("%q\n", bytes.Fields([]byte(" a  b c ")))
	fmt.Printf("%s\n", bytes.ToUpper([]byte("go")))
	fmt.Printf("%q\n", bytes.TrimSpace([]byte("  x \n")))
	fmt.Printf("%s\n", bytes.ReplaceAll([]byte("aXbXc"), []byte("X"), []byte("-")))
	fmt.Printf("%s\n", bytes.Join([][]byte{[]byte("a"), []byte("b")}, []byte(", ")))

	// Cut returns subslices of the input, not copies.
	k[0] = 'X'
	fmt.Println(string(b[:12]))
}
```

```bash
go run ./a
```

```text
true true
12 true
-1
Content-Type | text/html; charset=utf-8 | true
a/b c.txt
["a" "b" "c"]
GO
"x"
a-b-c
a, b
Xontent-Type
```

Every function has the same name and meaning as in [[strings-pkg]]: `Contains`, `Index`,
`HasPrefix`, `Cut`, `CutLast` (Go 1.27), `Fields`, `Split`, `Trim*`, `Replace*`, `ToUpper`,
`Join`, `EqualFold`. Three differences matter:

- **Comparison needs a function.** `[]byte` slices cannot be compared with `==`. Use
  `bytes.Equal(a, b)` (a nil slice equals an empty one) and `bytes.Compare(a, b)`, which
  returns `-1`, `0` or `1`.
- **Results can alias the input.** `Cut`, `Fields`, `Split`, `TrimSpace` and similar return
  **subslices** of the original, not copies. The last two lines of the example change `k`
  and the input `b` changes with it: the output starts with `X` instead of `C`. A
  subslice also keeps the whole backing array alive ([[slices-internals]]). Copy with
  `bytes.Clone` when you must outlive or modify the source.
- **Mutating functions return new slices.** `ToUpper`, `ReplaceAll` and `Join` allocate a
  new slice; they never edit the argument.

## bytes.Buffer

A `Buffer` holds a slice of bytes plus a read position. Writing appends at the end;
reading consumes from the front. The zero value is an empty buffer ready to use.

```go title="b/main.go"
package main

import (
	"bytes"
	"fmt"
	"io"
	"os"
)

func main() {
	var buf bytes.Buffer // zero value is ready
	buf.WriteString("hello ")
	buf.Write([]byte("world"))
	buf.WriteByte('!')
	fmt.Fprintf(&buf, " (%d)", 42)
	fmt.Println(buf.Len(), buf.String())

	p := make([]byte, 5)
	n, _ := buf.Read(p)
	fmt.Println(n, string(p), buf.Len())
	fmt.Printf("unread: %q\n", buf.String())

	line, err := buf.ReadString('!')
	fmt.Printf("%q %v\n", line, err)
	rest, err := buf.ReadString('\n')
	fmt.Printf("%q %v\n", rest, err)

	buf.Reset()
	buf.WriteString("copied")
	io.Copy(os.Stdout, &buf)
	fmt.Println()
	fmt.Println(buf.Len())

	r := bytes.NewReader([]byte("read-only"))
	b, _ := io.ReadAll(r)
	fmt.Println(string(b), r.Len(), r.Size())
}
```

```text
17 hello world! (42)
5 hello 12
unread: " world! (42)"
" world!" <nil>
" (42)" EOF
copied
0
read-only 0 9
```

How it works:

1. The writes (`WriteString`, `Write`, `WriteByte`, and `fmt.Fprintf` because `*Buffer` is an
   `io.Writer`) append and grow the underlying slice as needed.
2. `Read` copies up to `len(p)` unread bytes into `p` and advances the read position.
   `Len()` is the number of **unread** bytes, so it shrank from 17 to 12.
3. `String()` returns the unread portion as a new string. On a nil `*Buffer` it returns
   `<nil>`.
4. `ReadString(delim)` and `ReadBytes(delim)` read through the first `delim`. If the
   delimiter is not found they return everything left plus `io.EOF`, as for `" (42)"`.
5. `Reset()` empties the buffer but keeps the allocated memory for reuse.
6. `io.Copy(os.Stdout, &buf)` drains the buffer into any writer; afterwards `Len()` is `0`.

`bytes.NewReader(b)` is the read-only counterpart: an `io.Reader`, `io.Seeker` and
`io.ReaderAt` over a byte slice that never modifies it. Use `NewReader` when you only need to
read bytes you already have (as `strings.NewReader` does for a string), and `Buffer` when you
need to write first and read later.

### Typical uses

- **Build a payload** to send: write JSON or a form into a `Buffer`, then pass it as the body
  of an HTTP request (`http.NewRequest(method, url, &buf)`).
- **Capture output** in a test: pass `&buf` to a function that takes an `io.Writer` and
  assert on `buf.String()` ([[io-composition]]).
- **Assemble binary data** before writing it in one call ([[binary]]).

## Buffer.Bytes aliases the buffer

`Bytes()` returns the unread bytes **without copying**: a slice into the buffer's own
storage. It is valid only until the next call that modifies the buffer.

```go title="c/main.go"
package main

import (
	"bytes"
	"fmt"
)

func main() {
	var buf bytes.Buffer
	buf.WriteString("abcdef")

	view := buf.Bytes() // aliases the buffer's storage
	fmt.Println(string(view))
	buf.Reset()
	buf.WriteString("XY")
	fmt.Println(string(view)) // overwritten

	buf.Reset()
	buf.WriteString("abcdef")
	safe := bytes.Clone(buf.Bytes())
	buf.Reset()
	buf.WriteString("XY")
	fmt.Println(string(safe))

	// Next consumes n bytes; Truncate keeps the first n unread.
	buf.Reset()
	buf.WriteString("0123456789")
	fmt.Printf("%s\n", buf.Next(3))
	buf.Truncate(4)
	fmt.Printf("%s\n", buf.String())
	fmt.Println(buf.Cap() >= buf.Len())
}
```

```text
abcdef
XYcdef
abcdef
012
3456
true
```

After `Reset` and a new write, `view` still points at the same memory, so its first two
bytes became `XY`. The fix is to copy before you modify the buffer: `bytes.Clone(buf.Bytes())`
or `append([]byte(nil), buf.Bytes()...)`.

> [!WARNING]
> Keeping the result of `buf.Bytes()` (in a struct, a channel or a goroutine) while the buffer
> is reused is a data-corruption bug. Symptom: a stored message changes later, or two
> messages end up with the same content, usually only under load. Fix: copy, or use
> `buf.String()`, which returns a new string. The same rule applies to the slice a
> `bufio.Scanner` returns from `Bytes()` ([[bufio]]).

Other methods worth knowing: `Next(n)` returns and consumes the next `n` bytes (also an
alias), `Truncate(n)` keeps only the first `n` unread bytes, `Grow(n)` reserves space,
`ReadFrom(r)` reads from an `io.Reader` until EOF, `WriteTo(w)` drains into a writer, and
`UnreadByte`/`UnreadRune` step the read position back.

> [!NOTE]
> A `Buffer` is not safe for concurrent use, and copying one by value after use gives two
> buffers that share storage, so pass `*bytes.Buffer`. For building a **string** from
> pieces prefer `strings.Builder`; its `String()` does not copy. Use `bytes.Buffer` when you
> need the bytes, or need to read back what you wrote.

linkcheck renders its reports into a `bytes.Buffer` in tests to compare them with golden
files in [[step-7-reporters]].
