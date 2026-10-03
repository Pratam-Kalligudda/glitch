---
title: io.Reader and io.Writer composition
done_when: "You can write a custom io.Reader that honours the n-before-err contract, and build a pipeline with io.MultiReader, io.TeeReader, io.LimitReader and io.MultiWriter that hashes and copies a stream in one pass."
---
`io.Reader` and `io.Writer` are the two most important interfaces in Go. Each has one
method:

```go
type Reader interface {
	Read(p []byte) (n int, err error)
}

type Writer interface {
	Write(p []byte) (n int, err error)
}
```

Files, network connections, HTTP bodies, buffers, compressors, hashes and terminals all
satisfy one or both. Because the interfaces are tiny, the `io` package can offer generic
building blocks that wrap them: concatenate readers, copy what is read into a writer, cap
a stream, fan one write out to many writers. Code that accepts an `io.Reader` works on all
of those sources, and processes data as a **stream**: a chunk at a time, without loading
the whole input into memory.

## The Read contract

`Read` fills up to `len(p)` bytes of `p` and returns how many it filled. The rules, from
the `io.Reader` documentation:

- It returns `0 <= n <= len(p)`. Fewer than `len(p)` bytes is normal and is not an error.
- At the end of the input it returns `io.EOF`. It may return the last bytes and `io.EOF`
  in the *same* call, or the last bytes with `nil` and then `0, io.EOF` on the next call.
  Both are legal.
- **Callers must process the `n` bytes before looking at `err`.**
- `0, nil` means "nothing happened", not end of input.
- It must not keep `p` after returning.

```go title="main.go"
package main

import (
	"fmt"
	"io"
	"os"
	"strings"
)

// upperReader wraps any io.Reader and upper-cases ASCII letters as they pass through.
type upperReader struct {
	r io.Reader
}

func (u upperReader) Read(p []byte) (int, error) {
	n, err := u.r.Read(p)
	for i := range p[:n] { // only the n bytes just read are valid
		if 'a' <= p[i] && p[i] <= 'z' {
			p[i] -= 'a' - 'A'
		}
	}
	return n, err
}

func main() {
	// 1. The Read contract, one call at a time, with a deliberately small buffer.
	src := strings.NewReader("hello, gopher")
	buf := make([]byte, 5)
	for {
		n, err := src.Read(buf)
		fmt.Printf("n=%d err=%-4v data=%q\n", n, err, buf[:n])
		if err == io.EOF {
			break
		}
		if err != nil {
			fmt.Println("read failed:", err)
			return
		}
	}

	// 2. A custom Reader composed with io.Copy.
	written, err := io.Copy(os.Stdout, upperReader{strings.NewReader("streamed through upperReader\n")})
	fmt.Println("copied", written, "bytes, err:", err)
}
```

```bash
go run .
```

```text
n=5 err=<nil> data="hello"
n=5 err=<nil> data=", gop"
n=3 err=<nil> data="her"
n=0 err=EOF  data=""
STREAMED THROUGH UPPERREADER
copied 29 bytes, err: <nil>
```

## How it works

- `strings.NewReader` hands out at most 5 bytes per call because `buf` holds 5. The third
  call returns the 3 remaining bytes with `nil`; the fourth returns `0, io.EOF`. This
  reader chose the "EOF on the next call" style.
- `upperReader` is a **decorator**: it holds another `io.Reader`, forwards `Read` to it,
  then transforms exactly `p[:n]`. Bytes past `n` may be garbage from an earlier call. It
  returns the inner `err` unchanged, so `io.EOF` flows through.
- `io.Copy(dst, src)` loops: read into a 32 KiB buffer, write what was read, repeat until
  `io.EOF`. It returns `nil` on success, not `io.EOF`, because reaching the end is what it
  was asked to do. Before looping it checks for two optional methods (the capability
  assertions from [[assertions-switches]]): if `src` has `WriteTo` or `dst` has
  `ReadFrom`, it lets them do the copy, which can avoid the intermediate buffer.

## Composing a pipeline

The `io` package's wrappers each take readers or writers and return one, so they snap
together. This program reads three pieces as one page, hashes it, and writes it to three
destinations, in a single pass over the data:

```go title="main.go"
package main

import (
	"bytes"
	"crypto/sha256"
	"fmt"
	"io"
	"os"
	"strings"
)

// countingWriter counts bytes and lines written through it, and discards them.
type countingWriter struct {
	bytes, lines int
}

func (c *countingWriter) Write(p []byte) (int, error) {
	c.bytes += len(p)
	c.lines += bytes.Count(p, []byte("\n"))
	return len(p), nil
}

func main() {
	// Three sources read one after another as a single stream.
	page := io.MultiReader(
		strings.NewReader("<html>\n"),
		strings.NewReader("<a href=\"/docs\">docs</a>\n"),
		strings.NewReader("</html>\n"),
	)

	// Every byte read through tee is also written to the hash.
	hash := sha256.New()
	tee := io.TeeReader(page, hash)

	// Every byte written to out goes to stdout, a buffer and the counter.
	var saved bytes.Buffer
	counter := &countingWriter{}
	out := io.MultiWriter(os.Stdout, &saved, counter)

	n, err := io.Copy(out, tee)
	if err != nil {
		fmt.Println("copy:", err)
		return
	}
	fmt.Printf("copied %d bytes, %d lines\n", n, counter.lines)
	fmt.Printf("buffer holds %d bytes\n", saved.Len())
	fmt.Printf("sha256 %x\n", hash.Sum(nil))

	// LimitReader stops with io.EOF after n bytes.
	head, _ := io.ReadAll(io.LimitReader(strings.NewReader("abcdefghij"), 4))
	fmt.Printf("first 4 bytes: %q\n", head)
}
```

```bash
go run .
```

```text
<html>
<a href="/docs">docs</a>
</html>
copied 40 bytes, 3 lines
buffer holds 40 bytes
sha256 0db00e6b31155200ffede837c1f22f02574c368b5b4136f5587cae6f114ad9af
first 4 bytes: "abcd"
```

The data flows like this: `io.Copy` reads from `tee`; `tee` reads from `page` and, before
returning, writes the same bytes to `hash` (a `hash.Hash` is an `io.Writer`); `page` reads
its first reader to EOF, then the second, then the third. `io.Copy` then writes each chunk
to `out`, which writes it to `os.Stdout`, `saved` and `counter` in turn. No step knows what
the others are. `countingWriter` needs a pointer receiver because `Write` updates its
fields, so you pass `counter`, a pointer.

| Building block | Does |
|---|---|
| `io.MultiReader(rs...)` | Reads each reader to EOF in order, as one stream |
| `io.TeeReader(r, w)` | Returns a reader that writes to `w` everything it reads from `r`; a write error becomes a read error |
| `io.LimitReader(r, n)` | Returns `io.EOF` after `n` bytes, even if `r` has more |
| `io.MultiWriter(ws...)` | Writes each chunk to every writer in order; stops at the first error |
| `io.Copy(dst, src)` | Streams `src` into `dst`; `nil` error on EOF |
| `io.ReadAll(r)` | Reads everything into a `[]byte`; `nil` error on EOF |
| `io.Discard` | A writer that accepts and drops everything |
| `io.NopCloser(r)` | Adds a no-op `Close` so a reader fits an `io.ReadCloser` |

## The two mistakes

Both of these pass a casual test and fail on real input:

```go title="main.go"
package main

import (
	"errors"
	"fmt"
	"io"
	"strings"
	"testing/iotest"
)

// readWrong checks err before using n.
func readWrong(r io.Reader) string {
	var sb strings.Builder
	buf := make([]byte, 8)
	for {
		n, err := r.Read(buf)
		if err != nil {
			break
		}
		sb.Write(buf[:n])
	}
	return sb.String()
}

// readRight uses the n bytes first, then looks at err.
func readRight(r io.Reader) (string, error) {
	var sb strings.Builder
	buf := make([]byte, 8)
	for {
		n, err := r.Read(buf)
		sb.Write(buf[:n])
		if err == io.EOF {
			return sb.String(), nil
		}
		if err != nil {
			return sb.String(), err
		}
	}
}

var errTooLarge = errors.New("body too large")

// readLimited reads at most limit bytes and reports an error if there was more.
func readLimited(r io.Reader, limit int64) ([]byte, error) {
	data, err := io.ReadAll(io.LimitReader(r, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > limit {
		return data[:limit], errTooLarge
	}
	return data, nil
}

func main() {
	const text = "a reader may return data and io.EOF together"

	// DataErrReader returns the final bytes and io.EOF in the same call.
	fmt.Printf("wrong: %q\n", readWrong(iotest.DataErrReader(strings.NewReader(text))))
	got, err := readRight(iotest.DataErrReader(strings.NewReader(text)))
	fmt.Printf("right: %q err=%v\n", got, err)

	for _, body := range []string{"short", "this body is longer than ten bytes"} {
		data, err := readLimited(strings.NewReader(body), 10)
		fmt.Printf("limited: %q err=%v\n", data, err)
	}
}
```

```text
wrong: "a reader may return data and io.EOF toge"
right: "a reader may return data and io.EOF together" err=<nil>
limited: "short" err=<nil>
limited: "this body " err=body too large
```

`testing/iotest.DataErrReader` makes a reader return its last bytes together with
`io.EOF`, which files and network connections are allowed to do. `readWrong` drops that
final chunk. With `strings.NewReader` alone it would have passed, which is why the bug
survives tests.

> [!WARNING]
> Checking `err` before using `n` loses the last chunk of a stream. Symptom: files or
> response bodies are occasionally truncated, by up to one buffer. Fix: always handle
> `p[:n]` first, then `err`, or use `io.Copy`/`io.ReadAll`, which get it right.
>
> `io.LimitReader` truncates silently. Symptom: an oversized body is cut and processed as
> if it were complete. Fix: read `limit+1` bytes, as `readLimited` does, and treat
> anything over `limit` as an error.

> [!NOTE]
> `io.Copy` and `io.ReadAll` return `nil`, not `io.EOF`, on success. Comparing their error
> with `io.EOF` is a sign of confusion between the low-level `Read` contract and the
> helpers built on it. `bufio` adds buffering on top of these interfaces; see [[bufio]].

linkcheck caps every HTML body it reads with an `io.LimitReader` in
[[step-1-single-page]], writes every report format to an `io.Writer` in
[[step-7-reporters]], and hashes page bodies with SHA-256 to find duplicates in
[[step-8-state]].
