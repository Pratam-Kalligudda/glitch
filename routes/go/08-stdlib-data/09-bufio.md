---
title: bufio
---
Reading or writing a few bytes at a time straight from a file or socket costs one system call
per operation, and system calls are slow. `bufio` wraps an `io.Reader` or `io.Writer` with an
in-memory buffer so the real read or write happens in big chunks, and adds the conveniences
you want on top: reading a line, a word or a rune. It has three types: `Scanner` (the easy way
to read lines and tokens), `Reader` (more control) and `Writer` (batches small writes).

## Scanner: lines and words

```go title="a/main.go"
package main

import (
	"bufio"
	"fmt"
	"strings"
)

func main() {
	input := "alpha beta\ngamma\n\ndelta"

	sc := bufio.NewScanner(strings.NewReader(input))
	for sc.Scan() {
		fmt.Printf("line %q\n", sc.Text())
	}
	fmt.Println("err:", sc.Err())

	words := bufio.NewScanner(strings.NewReader(input))
	words.Split(bufio.ScanWords)
	n := 0
	for words.Scan() {
		n++
	}
	fmt.Println("words:", n)

	runes := bufio.NewScanner(strings.NewReader("héy"))
	runes.Split(bufio.ScanRunes)
	for runes.Scan() {
		fmt.Print(runes.Text(), "|")
	}
	fmt.Println()
}
```

```bash
go run ./a
```

```text
line "alpha beta"
line "gamma"
line ""
line "delta"
err: <nil>
words: 4
h|é|y|
```

How the loop works: `sc.Scan()` reads the next token and returns `true`; `sc.Text()` gives it as
a string (without the line ending). When `Scan` returns `false` the input is exhausted **or**
something failed, so afterwards call `sc.Err()`: it returns `nil` for a normal end of input.
Skipping that check is how read errors get lost.

The default split function is `bufio.ScanLines`. It strips `\n` and a preceding `\r`, so Windows
files work, and it yields a final line that has no newline (`delta`) and empty lines (`""`).
Call `sc.Split(f)` **before** the first `Scan` to change what a token is:

| Split function | Token |
|---|---|
| `bufio.ScanLines` | A line (the default) |
| `bufio.ScanWords` | A run of non-space characters |
| `bufio.ScanRunes` | One UTF-8 character |
| `bufio.ScanBytes` | One byte |
| your own `SplitFunc` | Anything: see below |

Because a `Scanner` takes any `io.Reader`, the same loop reads a file, `os.Stdin`, an HTTP
response body or a `strings.Reader`. Reading standard input line by line is
`bufio.NewScanner(os.Stdin)`.

## The "token too long" error

A `Scanner` buffers the token it is building, and it has a **maximum token size: 64 KiB**
(`bufio.MaxScanTokenSize`, 65536). A longer line makes `Scan` stop:

```go title="b/main.go"
package main

import (
	"bufio"
	"fmt"
	"strings"
)

func main() {
	long := strings.Repeat("x", 70*1024) + "\nnext\n"

	sc := bufio.NewScanner(strings.NewReader(long))
	for sc.Scan() {
		fmt.Println("line of", len(sc.Text()))
	}
	fmt.Println("err:", sc.Err())

	sc = bufio.NewScanner(strings.NewReader(long))
	sc.Buffer(make([]byte, 0, 64*1024), 1024*1024) // allow lines up to 1 MiB
	for sc.Scan() {
		fmt.Println("line of", len(sc.Text()))
	}
	fmt.Println("err:", sc.Err())
	fmt.Println(bufio.MaxScanTokenSize)
}
```

```text
err: bufio.Scanner: token too long
line of 71680
line of 4
err: <nil>
65536
```

The first loop printed nothing and `Err()` returned `bufio.Scanner: token too long`. The second
loop raised the limit with `sc.Buffer(initial, max)`: the first argument is the starting buffer
(it grows up to `max`), and the lines now come through.

> [!WARNING]
> A `for sc.Scan() { ... }` loop that does not check `sc.Err()` silently stops at the first
> line over 64 KiB, so a minified JSON file, a long log line or a base64 blob truncates your
> data without a message. Symptom: your program processes only the lines before the long one
> and exits normally. Fix: always check `sc.Err()`, call `sc.Buffer` with a limit that suits your
> data, or use `bufio.Reader.ReadString`, which has no limit (they allocate
> as much as the line needs, so cap it yourself for untrusted input).

## Scanner reuses its buffer

`sc.Bytes()` returns a slice into the scanner's internal buffer and `sc.Text()` returns a copy as
a string. The slice is only valid until the next `Scan`. Keeping it is a bug that appears only
on larger inputs, because the buffer is overwritten when it is refilled:

```go title="e/main.go"
package main

import (
	"bufio"
	"fmt"
	"strings"
)

func main() {
	var in strings.Builder
	for i := range 1000 {
		fmt.Fprintf(&in, "line %04d\n", i)
	}

	sc := bufio.NewScanner(strings.NewReader(in.String()))
	var kept [][]byte
	var copied []string
	for sc.Scan() {
		if len(kept) < 3 {
			kept = append(kept, sc.Bytes()) // aliases the scanner's buffer
			copied = append(copied, sc.Text())
		}
	}
	fmt.Printf("%q\n", kept)
	fmt.Printf("%q\n", copied)

	// A custom split function: comma separated fields.
	cs := bufio.NewScanner(strings.NewReader("x,y,,z"))
	cs.Split(func(data []byte, atEOF bool) (int, []byte, error) {
		if atEOF && len(data) == 0 {
			return 0, nil, nil
		}
		if i := strings.IndexByte(string(data), ','); i >= 0 {
			return i + 1, data[:i], nil
		}
		if atEOF {
			return len(data), data, nil
		}
		return 0, nil, nil // ask for more data
	})
	for cs.Scan() {
		fmt.Printf("%q ", cs.Text())
	}
	fmt.Println()
}
```

```text
["line 0818" "line 0819" "line 0820"]
["line 0000" "line 0001" "line 0002"]
"x" "y" "" "z" 
```

The `kept` slices, saved from the first three lines, now show lines 818 to 820, because the
scanner reused the memory. The strings from `Text()` are intact. Copy (`string(b)` or
`bytes.Clone`) whatever you store, as with `bytes.Buffer.Bytes` ([[bytes-buffer]]).

The same example defines a custom `SplitFunc` for comma-separated fields. Its contract:
it receives the unread `data` and whether the input has ended (`atEOF`), and returns how many
bytes to advance, the token (or `nil`), and an error. Returning `0, nil, nil` means "I need more
data". Return `bufio.ErrFinalToken` with a token to stop cleanly after it.

## Reader: when you need more control

`bufio.NewReader(r)` gives `ReadString(delim)`, `ReadBytes(delim)`, `ReadLine`, `ReadRune`,
`ReadByte`, `UnreadByte`, `UnreadRune` and `Peek(n)` (look ahead without consuming).

```go title="c/main.go"
package main

import (
	"bufio"
	"fmt"
	"io"
	"strings"
)

func main() {
	r := bufio.NewReader(strings.NewReader("first line\nsecond line\nno newline at end"))
	for {
		line, err := r.ReadString('\n')
		fmt.Printf("%q %v\n", line, err)
		if err == io.EOF {
			break
		}
	}

	r = bufio.NewReader(strings.NewReader("abc"))
	b, _ := r.Peek(2)
	fmt.Printf("peek %q\n", b)
	c, _ := r.ReadByte()
	r.UnreadByte()
	ru, size, _ := r.ReadRune()
	fmt.Println(string(c), string(ru), size, r.Buffered())
}
```

```text
"first line\n" <nil>
"second line\n" <nil>
"no newline at end" EOF
peek "ab"
a a 1 2
```

`ReadString('\n')` returns the text **including** the delimiter, plus an error. At the end of the
input the last chunk arrives **together with** `io.EOF` (`"no newline at end"`), so process the
returned text before you test the error, as the loop does. An empty file gives `""` and `EOF`.
`Buffered()` is the number of bytes already in the buffer. `NewReaderSize(r, n)` sets the buffer
size (default 4096).

Use `Scanner` for ordinary line and token reading and `Reader` when you must mix lines with
binary data, peek at a prefix to detect a format, or read lines of unbounded length.

## Writer: batch small writes

```go title="d/main.go"
package main

import (
	"bufio"
	"fmt"
	"os"
)

type countingWriter struct{ writes int }

func (c *countingWriter) Write(p []byte) (int, error) { c.writes++; return len(p), nil }

func main() {
	var raw countingWriter
	for i := range 1000 {
		fmt.Fprintln(&raw, "line", i)
	}
	fmt.Println("unbuffered underlying writes:", raw.writes)

	var buffered countingWriter
	w := bufio.NewWriter(&buffered)
	for i := range 1000 {
		fmt.Fprintln(w, "line", i)
	}
	fmt.Println("before Flush:", buffered.writes, "buffered bytes:", w.Buffered(), "available:", w.Available())
	w.Flush()
	fmt.Println("after Flush:", buffered.writes)

	out := bufio.NewWriter(os.Stdout)
	defer out.Flush() // forgetting this loses the tail of the output
	fmt.Fprintln(out, "hello from a buffered writer")
}
```

```text
unbuffered underlying writes: 1000
before Flush: 2 buffered bytes: 698 available: 3398
after Flush: 3
hello from a buffered writer
```

Each `Fprintln` to the raw writer is one `Write` call: 1000 of them. Through `bufio.Writer` the
same 1000 lines reach the underlying writer in 3 calls: the buffer (4096 bytes by default) fills,
is written out and starts again. `Buffered()` is how many bytes wait in the buffer and
`Available()` how much room is left.

**`Flush` is mandatory.** Data stays in the buffer until it is full or you call `Flush`. When
the program ends the buffer is not written for you, so the tail of the output is lost.
`defer out.Flush()` right after creating the writer is the usual pattern. If the destination is
a file, close it after flushing, and check both errors.

> [!WARNING]
> Forgetting `Flush` loses the last partial buffer. Symptom: output files that end mid-line,
> or a program that prints less when stdout is a pipe than on screen. A `bufio.Writer` also
> remembers the first write error and returns it from every later call, so check the error
> from `Flush`. Fix: `defer w.Flush()` immediately, and for files `if err := w.Flush(); err !=
> nil` before `f.Close()`.

Also, a buffered `os.Stdout` is not flushed before `os.Exit`, `log.Fatal` or a panic: flush
explicitly before those. For interleaving with `os.Stderr` messages, keep the buffer
small or flush before writing the error.

| Need | Use |
|---|---|
| Lines or words from a reader | `bufio.Scanner` |
| Lines longer than 64 KiB | `sc.Buffer(...)` or `Reader.ReadString` |
| Peek, unread, mixed text and binary | `bufio.Reader` |
| Many small writes to a file or socket | `bufio.Writer` plus `Flush` |
| Both directions on one connection | `bufio.NewReadWriter(r, w)` |

linkcheck streams its text report through a `bufio.Writer` in [[step-7-reporters]]. It does
not read files line by line: start URLs come from the command line or the JSON config.
