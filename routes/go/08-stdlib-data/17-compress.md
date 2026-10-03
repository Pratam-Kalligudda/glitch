---
title: Compression and archives
---
Two different jobs share this area, and mixing them up is the first thing to get straight.

- **Compression** makes **one stream** of bytes smaller: `compress/gzip`, `compress/zlib`,
  `compress/flate`, `compress/bzip2` (read only), `compress/lzw`. A `.gz` file holds one file's
  data and its name.
- **An archive** bundles **many files** with their names, sizes and permissions into one:
  `archive/zip` and `archive/tar`. A `.zip` compresses each file inside it. A `.tar` does not
  compress; `.tar.gz` is a tar stream passed through gzip.

All of them are layered on `io.Reader` and `io.Writer` ([[io-composition]]): a compressor is a
writer wrapped around another writer, and a decompressor a reader wrapped around another reader.

## gzip

```go title="a/main.go"
package main

import (
	"bytes"
	"compress/gzip"
	"fmt"
	"io"
	"log"
	"strings"
)

func main() {
	text := strings.Repeat(`{"url":"https://example.com/page","status":200}`+"\n", 200)

	var buf bytes.Buffer
	zw := gzip.NewWriter(&buf)
	zw.Name = "report.ndjson"
	if _, err := io.WriteString(zw, text); err != nil {
		log.Fatal(err)
	}
	if err := zw.Close(); err != nil { // writes the trailer: required
		log.Fatal(err)
	}
	fmt.Println("original:", len(text), "compressed:", buf.Len())
	fmt.Printf("magic bytes: % x\n", buf.Bytes()[:3])

	zr, err := gzip.NewReader(&buf)
	if err != nil {
		log.Fatal(err)
	}
	defer zr.Close()
	fmt.Println("name in header:", zr.Name)
	out, err := io.ReadAll(zr)
	fmt.Println(len(out), err, string(out) == text)

	// Not gzip data.
	_, err = gzip.NewReader(strings.NewReader("plain text"))
	fmt.Println(err)

	// A level is a trade of speed for size.
	for _, lvl := range []int{gzip.NoCompression, gzip.BestSpeed, gzip.DefaultCompression, gzip.BestCompression} {
		var b bytes.Buffer
		w, _ := gzip.NewWriterLevel(&b, lvl)
		io.WriteString(w, text)
		w.Close()
		fmt.Println("level", lvl, "bytes", b.Len())
	}
}
```

```bash
go run ./a
```

```text
original: 9600 compressed: 128
magic bytes: 1f 8b 08
name in header: report.ndjson
9600 <nil> true
gzip: invalid header
level 0 bytes 9625
level 1 bytes 114
level -1 bytes 114
level 9 bytes 114
```

What happens:

- `gzip.NewWriter(w)` returns a writer; bytes you write are compressed and passed to `w`. The
  header fields (`Name`, `ModTime`, `Comment`) must be set **before the first write**.
- **`Close()` is mandatory.** It flushes what is buffered and writes the trailer, a checksum and
  the length. `Close` does not close the underlying writer.
- The output starts with the magic bytes `1f 8b`, which is how tools recognise gzip.
- `gzip.NewReader(r)` reads the header, so it fails right away on data that is not gzip:
  `gzip: invalid header`. Then `io.ReadAll(zr)` or `io.Copy` decompresses, and verifies the checksum
  at the end. Close the reader too.
- Repetitive text compresses extremely well (9600 bytes to 128); random or already compressed data
  (JPEG, zip, encrypted bytes) does not, and a stored copy can even grow.
- `NewWriterLevel` trades time for size: `gzip.BestSpeed` (1), `DefaultCompression` (-1, which
  means level 6) and `BestCompression` (9). Level `NoCompression` (0) stores the data in
  blocks and makes it slightly bigger. The default is right unless a measurement says otherwise.

What goes wrong without `Close`:

```go title="b/main.go"
package main

import (
	"bytes"
	"compress/gzip"
	"fmt"
	"io"
	"strings"
)

func main() {
	var buf bytes.Buffer
	zw := gzip.NewWriter(&buf)
	io.WriteString(zw, strings.Repeat("hello gzip ", 100))
	// Forgot zw.Close()
	fmt.Println("compressed bytes without Close:", buf.Len())

	zr, err := gzip.NewReader(&buf)
	if err != nil {
		fmt.Println("NewReader:", err)
		return
	}
	_, err = io.ReadAll(zr)
	fmt.Println("ReadAll:", err)
}
```

```text
compressed bytes without Close: 10
ReadAll: unexpected EOF
```

Only the 10-byte header was written. The reader finds the header valid and then runs out of data
before the end of the stream: `unexpected EOF`.

> [!WARNING]
> Forgetting `zw.Close()` (or ignoring its error) produces a truncated, unreadable file, and a
> `defer zw.Close()` without checking the error hides a failed final write. Symptom: `gzip: invalid
> header` or `unexpected EOF` when reading the file back, often only for larger outputs.
> Fix: close in the right order, **inner to outer**, and check the errors on the way out:
> `zw.Close()`, then the file's `Close()`. If a `gzip.Writer` wraps a `bufio.Writer`, flush the
> buffer after closing gzip.

Related packages: `compress/zlib` is the same algorithm (deflate) with a shorter header, used by
PNG images and Git. `compress/flate` is the raw deflate stream, which gzip, zlib and zip all use.
`net/http` handles `Content-Encoding: gzip` on responses for you in the client by default
([[http-client]]).

> [!NOTE]
> Go 1.27 makes `compress/flate` faster, and its output differs from Go 1.26. Compressed bytes are
> therefore not a stable fingerprint: do not compare compressed output byte for byte in tests
> or use it as a cache key (the output of `compress/gzip`, `compress/zlib`, `archive/zip` and
> `image/png` changes with it). Compare the decompressed data.

## zip: many files, random access

`archive/zip` writes and reads zip archives. A zip has a table of contents at the end, so it needs
random access (`io.ReaderAt` and a size) to open, and you can read any entry without reading the others.

```go title="c/main.go"
package main

import (
	"archive/zip"
	"bytes"
	"fmt"
	"io"
	"io/fs"
	"log"
	"path/filepath"
	"strings"
)

func main() {
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for _, f := range []struct{ name, body string }{
		{"README.md", "# hello"},
		{"docs/a.txt", "alpha"},
		{"docs/b.txt", "beta beta beta"},
		{"../evil.txt", "escape"},
	} {
		w, err := zw.Create(f.name)
		if err != nil {
			log.Fatal(err)
		}
		io.WriteString(w, f.body)
	}
	if err := zw.Close(); err != nil {
		log.Fatal(err)
	}

	zr, err := zip.NewReader(bytes.NewReader(buf.Bytes()), int64(buf.Len()))
	fmt.Println("NewReader err:", err)
	if zr == nil {
		return
	}
	for _, f := range zr.File {
		safe := filepath.IsLocal(f.Name)
		fmt.Printf("%-12s size=%-3d compressed=%-3d method=%d safe=%v\n", f.Name, f.UncompressedSize64, f.CompressedSize64, f.Method, safe)
	}

	// Reader is an fs.FS: read by name.
	data, err := fs.ReadFile(zr, "docs/a.txt")
	fmt.Printf("%s %v\n", data, err)

	rc, _ := zr.File[2].Open()
	b, _ := io.ReadAll(io.LimitReader(rc, 1<<20))
	rc.Close()
	fmt.Println(strings.ToUpper(string(b)))
}
```

```text
NewReader err: <nil>
README.md    size=7   compressed=14  method=8 safe=true
docs/a.txt   size=5   compressed=12  method=8 safe=true
docs/b.txt   size=14  compressed=21  method=8 safe=true
../evil.txt  size=6   compressed=13  method=8 safe=false
alpha <nil>
BETA BETA BETA
```

- `zw.Create(name)` starts a new entry and returns a writer for its contents; entries are
  compressed with deflate (method 8). `zw.Close()` writes the table of contents.
- `zip.NewReader(r, size)` reads from any `io.ReaderAt`: a `bytes.Reader`, or an `*os.File` with
  its size from `Stat`. `zip.OpenReader(path)` does both for a file name.
- `zr.File` lists the entries with `Name`, `UncompressedSize64`, `CompressedSize64` and `Method`.
  `f.Open()` returns a reader for one entry.
- `*zip.Reader` implements `fs.FS`, so `fs.ReadFile(zr, "docs/a.txt")` and
  `fs.WalkDir` work on it ([[filepath-fs]]).
- Names inside an archive use `/`, and the **writer does not check them**: the archive above
  contains `../evil.txt`.

### Extracting safely

An archive is data from someone else. Two attacks matter:

- **Path traversal ("zip slip")**: an entry named `../../home/user/.ssh/authorized_keys` writes
  outside the destination if you join its name onto a directory without checking.
- **Decompression bomb**: a few kilobytes that expand to gigabytes and fill the disk or memory.

Go does not reject unsafe names by default (`NewReader` reports `zip.ErrInsecurePath` only when the
`GODEBUG` setting `zipinsecurepath=0` is set), so check yourself. `os.OpenRoot` ([[os-files]]) does
the path confinement, and `io.LimitReader` the size limit:

```go title="e/main.go"
package main

import (
	"archive/zip"
	"bytes"
	"fmt"
	"io"
	"io/fs"
	"log"
	"os"
	"path"
	"path/filepath"
)

// extract unpacks zr into dir. os.Root refuses any name that leaves dir,
// so a "zip slip" entry such as ../evil.txt is an error, not a write.
func extract(zr *zip.Reader, dir string) error {
	root, err := os.OpenRoot(dir)
	if err != nil {
		return err
	}
	defer root.Close()

	const maxFile = 10 << 20 // refuse files that expand beyond 10 MiB
	for _, f := range zr.File {
		if !filepath.IsLocal(f.Name) {
			return fmt.Errorf("unsafe name in archive: %q", f.Name)
		}
		if f.FileInfo().IsDir() {
			if err := root.MkdirAll(f.Name, 0o755); err != nil {
				return err
			}
			continue
		}
		if err := root.MkdirAll(path.Dir(f.Name), 0o755); err != nil {
			return err
		}
		src, err := f.Open()
		if err != nil {
			return err
		}
		dst, err := root.Create(f.Name)
		if err != nil {
			src.Close()
			return err
		}
		n, err := io.Copy(dst, io.LimitReader(src, maxFile+1))
		src.Close()
		if cerr := dst.Close(); err == nil {
			err = cerr
		}
		if err != nil {
			return err
		}
		if n > maxFile {
			return fmt.Errorf("%s: larger than %d bytes", f.Name, maxFile)
		}
	}
	return nil
}

func build(names ...string) *zip.Reader {
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for _, n := range names {
		w, _ := zw.Create(n)
		io.WriteString(w, "content of "+n)
	}
	zw.Close()
	zr, err := zip.NewReader(bytes.NewReader(buf.Bytes()), int64(buf.Len()))
	if err != nil {
		log.Fatal(err)
	}
	return zr
}

func main() {
	dir, err := os.MkdirTemp("", "extract-*")
	if err != nil {
		log.Fatal(err)
	}
	defer os.RemoveAll(dir)

	fmt.Println(extract(build("a.txt", "docs/b.txt"), dir))
	fs.WalkDir(os.DirFS(dir), ".", func(p string, d fs.DirEntry, err error) error {
		if !d.IsDir() {
			fmt.Println("extracted", p)
		}
		return nil
	})
	fmt.Println(extract(build("ok.txt", "../evil.txt"), dir))
}
```

```text
<nil>
extracted a.txt
extracted docs/b.txt
unsafe name in archive: "../evil.txt"
```

The unsafe entry is rejected before any file is written, by `filepath.IsLocal` on the name and
again by `os.Root`, which also stops a symbolic link from leading out. Note that the second archive
had `ok.txt` before the bad entry: extraction stops, but `ok.txt` was already written. Validate every
name first when you need all-or-nothing, or extract into a fresh temporary directory and rename it
when finished.

> [!WARNING]
> `filepath.Join(dir, f.Name)` followed by `os.Create` is the classic zip-slip bug, and the same
> goes for tar. Symptom: files appear outside the target directory, or existing files are
> overwritten, when a hostile archive is unpacked. Fix: reject names with `filepath.IsLocal`, and
> write through `os.Root` as above. Also cap the total and per-file size.

## tar and tar.gz

`archive/tar` is a stream format: entries follow each other, each a header and its bytes, with no table of
contents. It carries Unix permissions, owners and symbolic links, which is why it is the format of
source releases and container images. It does not compress, so you wrap it in gzip.

```go title="d/main.go"
package main

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"fmt"
	"io"
	"log"
)

func main() {
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	for _, f := range []struct{ name, body string }{{"a.txt", "alpha"}, {"dir/b.txt", "beta"}} {
		hdr := &tar.Header{Name: f.name, Mode: 0o644, Size: int64(len(f.body))}
		if err := tw.WriteHeader(hdr); err != nil {
			log.Fatal(err)
		}
		if _, err := tw.Write([]byte(f.body)); err != nil {
			log.Fatal(err)
		}
	}
	// Close in reverse order: tar first, then gzip.
	if err := tw.Close(); err != nil {
		log.Fatal(err)
	}
	if err := gz.Close(); err != nil {
		log.Fatal(err)
	}

	zr, err := gzip.NewReader(&buf)
	if err != nil {
		log.Fatal(err)
	}
	tr := tar.NewReader(zr)
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			log.Fatal(err)
		}
		body, _ := io.ReadAll(tr)
		fmt.Printf("%s %d %q\n", hdr.Name, hdr.Size, body)
	}
}
```

```text
a.txt 5 "alpha"
dir/b.txt 4 "beta"
```

For writing, `tw.WriteHeader(hdr)` must be followed by exactly `hdr.Size` bytes. **Close the writers in
reverse order of creation**: tar first (it writes the end-of-archive marker), then gzip. For reading,
`tr.Next()` moves to the next entry (`io.EOF` at the end) and the reader `tr` then yields that entry's
bytes. As with zip, validate `hdr.Name` before using it, and tar also holds symbolic links and device
files that you probably should not recreate.

| Need | Use |
|---|---|
| One file, smaller | `compress/gzip` around a file or a network stream |
| Many files, random access, Windows-friendly | `archive/zip` |
| Many files, streaming, Unix metadata | `archive/tar` plus `compress/gzip` |
| Compress in memory with a tiny header | `compress/zlib` |
| Read a `.bz2` | `compress/bzip2` (no writer in the standard library) |

linkcheck writes its saved crawl state through a `gzip.Writer` and reads it back through a
`gzip.Reader` in [[step-8-state]].
