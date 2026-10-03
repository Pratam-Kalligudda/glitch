---
title: encoding/binary
---
Network protocols, file formats and databases are defined as exact bytes: "a 4-byte length,
then 2 bytes of flags". `encoding/binary` converts between Go numbers and those bytes. The
central question is **byte order** (endianness): a 32-bit number takes four bytes, and the
format must say which comes first. **Big-endian** puts the most significant byte first (the
"network byte order" of internet protocols); **little-endian** puts it last (the native order
of x86 and ARM processors, and of many file formats).

## Fixed-size numbers

`binary.BigEndian` and `binary.LittleEndian` are values with methods for 16, 32 and 64-bit
unsigned integers:

```go title="a/main.go"
package main

import (
	"encoding/binary"
	"fmt"
)

func main() {
	buf := make([]byte, 8)

	binary.BigEndian.PutUint32(buf, 0x01020304)
	fmt.Println("big   ", buf[:4])
	binary.LittleEndian.PutUint32(buf, 0x01020304)
	fmt.Println("little", buf[:4])

	binary.BigEndian.PutUint16(buf[4:], 0xCAFE)
	fmt.Printf("% x\n", buf)
	fmt.Printf("%#x\n", binary.BigEndian.Uint16(buf[4:]))
	fmt.Printf("%#x\n", binary.LittleEndian.Uint16(buf[4:]))

	// Append form allocates for you.
	b := binary.BigEndian.AppendUint64(nil, 1<<40+5)
	fmt.Println(b, binary.BigEndian.Uint64(b))

	// Varints: small numbers take fewer bytes.
	for _, v := range []uint64{1, 127, 128, 300, 1 << 32} {
		vb := binary.AppendUvarint(nil, v)
		got, n := binary.Uvarint(vb)
		fmt.Println(v, vb, got, n)
	}
	sv := binary.AppendVarint(nil, -3)
	fmt.Println(sv)
	_, n := binary.Uvarint([]byte{0x80})
	fmt.Println("truncated:", n)
}
```

```bash
go run ./a
```

```text
big    [1 2 3 4]
little [4 3 2 1]
04 03 02 01 ca fe 00 00
0xcafe
0xfeca
[0 0 1 0 0 0 0 5] 1099511627781
1 [1] 1 1
127 [127] 127 1
128 [128 1] 128 2
300 [172 2] 300 2
4294967296 [128 128 128 128 16] 4294967296 5
[5]
truncated: 0
```

- `PutUint32(buf, v)` writes into the first 4 bytes of `buf` and panics if `buf` is shorter.
  `Uint32(buf)` reads them. `AppendUint32(dst, v)` appends to a slice and returns it. The same
  exist for 16 and 64 bits.
- The same number gives `[1 2 3 4]` in big-endian and `[4 3 2 1]` in little-endian, and reading
  with the wrong order silently gives a different number: `0xCAFE` read back little-endian is
  `0xFECA`. There is no marker in the data; the format definition is the only authority.
- For signed numbers, convert: `int32(binary.BigEndian.Uint32(b))`.

### Variable-length integers

A **varint** stores small numbers in fewer bytes: 7 bits of value per byte, with the high bit
saying "more bytes follow". `1` takes one byte, `300` takes two, `1<<32` takes five.
Protocol Buffers and many database formats use them.

- `binary.AppendUvarint(dst, v)` and `binary.Uvarint(b)` for unsigned numbers; `AppendVarint` and
  `Varint` for signed numbers (zig-zag encoded, so `-3` is the single byte `5`).
- `Uvarint` returns the value and the number of bytes read: `n == 0` means the buffer was too
  small (as in the `truncated` line), and `n < 0` means the value overflowed 64 bits. Always check
  `n`.

## Structs: Read and Write

For a fixed layout, describe it as a struct and let the package do the field-by-field work:

```go title="b/main.go"
package main

import (
	"bytes"
	"encoding/binary"
	"fmt"
	"log"
)

// Header is a fixed-size wire format: only fixed-size fields are allowed.
type Header struct {
	Magic   [4]byte
	Version uint16
	Flags   uint16
	Length  uint32
	Offset  int64
}

func main() {
	h := Header{Magic: [4]byte{'L', 'C', 'K', '1'}, Version: 2, Flags: 0b101, Length: 1024, Offset: -1}

	var buf bytes.Buffer
	if err := binary.Write(&buf, binary.BigEndian, h); err != nil {
		log.Fatal(err)
	}
	fmt.Println(buf.Len(), binary.Size(h))
	fmt.Printf("% x\n", buf.Bytes())

	var back Header
	if err := binary.Read(&buf, binary.BigEndian, &back); err != nil {
		log.Fatal(err)
	}
	fmt.Printf("%s %+v\n", back.Magic[:], back)

	// Variable-size types are rejected.
	err := binary.Write(&buf, binary.BigEndian, struct{ N int }{1})
	fmt.Println(err)
	err = binary.Write(&buf, binary.BigEndian, struct{ S string }{"x"})
	fmt.Println(err)

	// Short input.
	var short Header
	err = binary.Read(bytes.NewReader([]byte{1, 2, 3}), binary.BigEndian, &short)
	fmt.Println(err)
	err = binary.Read(bytes.NewReader(nil), binary.BigEndian, &short)
	fmt.Println(err)
}
```

```text
20 20
4c 43 4b 31 00 02 00 05 00 00 04 00 ff ff ff ff ff ff ff ff
LCK1 {Magic:[76 67 75 49] Version:2 Flags:5 Length:1024 Offset:-1}
binary.Write: some values are not fixed-sized in type struct { N int }
binary.Write: some values are not fixed-sized in type struct { S string }
unexpected EOF
EOF
```

`binary.Write(w, order, data)` writes `data` to an `io.Writer` ([[io-composition]]);
`binary.Read(r, order, &data)` fills a value from an `io.Reader`. `binary.Size(v)` is the encoded
size. How it works and what to know:

- **Only fixed-size types are allowed**: `int8` to `int64`, `uint8` to `uint64`, floats, `bool`,
  complex numbers, and arrays or structs of those. `int` and `uint` (their size depends on the
  platform), `string`, slices and maps are rejected: `binary.Write: some values are not
  fixed-sized in type struct { N int }`. Use `int32` or `int64`.
- **Fields are written in order, with no padding.** The Go struct in memory may have padding
  between fields; the wire form does not (`Size` is 20 bytes: `4+2+2+4+8`). Blank-named `_`
  fields are skipped on read and written as zeros.
- **Errors**: reading from a source with fewer bytes than the type needs returns
  `io.ErrUnexpectedEOF` (`unexpected EOF`), and from an empty source `io.EOF`. Use
  `errors.Is` to tell "stream ended cleanly" from "stream was cut off" ([[is-as]]).
- `binary.Read` and `Write` use reflection, so they are convenient and slow. For hot paths write
  the fields with `PutUint32` and friends. `binary.Append`, `binary.Encode` and `binary.Decode`
  (Go 1.23) do the same struct work with byte slices instead of readers and writers.

## Framing: length-prefixed messages

A stream of bytes has no message boundaries. The usual fix is to send each message as a length
followed by that many bytes:

```go title="c/main.go"
package main

import (
	"bytes"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
)

// A length-prefixed message: 4-byte big-endian length, then the payload.
func writeMsg(w io.Writer, payload []byte) error {
	var n [4]byte
	binary.BigEndian.PutUint32(n[:], uint32(len(payload)))
	if _, err := w.Write(n[:]); err != nil {
		return err
	}
	_, err := w.Write(payload)
	return err
}

const maxMsg = 1 << 20

func readMsg(r io.Reader) ([]byte, error) {
	var n [4]byte
	if _, err := io.ReadFull(r, n[:]); err != nil {
		return nil, err // io.EOF if the stream ended cleanly between messages
	}
	size := binary.BigEndian.Uint32(n[:])
	if size > maxMsg {
		return nil, fmt.Errorf("message of %d bytes exceeds limit %d", size, maxMsg)
	}
	payload := make([]byte, size)
	if _, err := io.ReadFull(r, payload); err != nil {
		return nil, fmt.Errorf("short message: %w", err)
	}
	return payload, nil
}

func main() {
	var wire bytes.Buffer
	writeMsg(&wire, []byte("hello"))
	writeMsg(&wire, []byte("second message"))
	fmt.Printf("% x\n", wire.Bytes()[:9])

	for {
		m, err := readMsg(&wire)
		if errors.Is(err, io.EOF) {
			fmt.Println("end of stream")
			break
		}
		if err != nil {
			fmt.Println(err)
			break
		}
		fmt.Printf("%q\n", m)
	}

	// A truncated stream and a hostile length.
	_, err := readMsg(bytes.NewReader([]byte{0, 0, 0, 9, 'a', 'b'}))
	fmt.Println(err, errors.Is(err, io.ErrUnexpectedEOF))
	_, err = readMsg(bytes.NewReader([]byte{0xff, 0xff, 0xff, 0xff}))
	fmt.Println(err)
}
```

```text
00 00 00 05 68 65 6c 6c 6f
"hello"
"second message"
end of stream
short message: unexpected EOF true
message of 4294967295 bytes exceeds limit 1048576
```

Three things make `readMsg` safe:

1. **`io.ReadFull`** keeps reading until the buffer is full, because a single `Read` may return
   fewer bytes than asked. A bare `r.Read(buf)` is wrong for a network connection.
2. **The two EOF errors mean different things.** `io.EOF` when no bytes of a header were read: the
   peer closed between messages. `io.ErrUnexpectedEOF` (wrapped with `%w`) when the stream ends
   inside a message.
3. **The length is validated before allocating.** A peer that sends `ff ff ff ff` must not be able
   to make you allocate 4 GiB; the limit turns that into an error.

> [!WARNING]
> Trusting a length read from the wire is a denial-of-service bug: `make([]byte, size)` with a
> hostile `size` exhausts memory or panics. Symptom: a server that crashes or is killed after a
> malformed or hostile packet. Fix: enforce a maximum, as `maxMsg` does, before you allocate.

> [!WARNING]
> Using the wrong byte order is silent. Symptom: lengths that are enormous (`16777216` instead of
> `1`) or flags that are "backwards" when talking to another system. Fix: write the byte order in
> the format's documentation, use one `binary.BigEndian`/`LittleEndian` constant for the format,
> and test with a known byte string from the specification.

linkcheck itself does not need raw bytes. Its saved state in [[step-8-state]] is compressed text, from
[[compress]]; the next stop, [[gob]], is Go's own binary format for Go values.
