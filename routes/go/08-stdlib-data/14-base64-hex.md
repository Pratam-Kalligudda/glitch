---
title: Base64 and hex
---
Binary data does not fit in text formats. A JSON string, an HTTP header, a URL, a config file
and an e-mail body all expect printable characters. **Base64** and **hex** encode arbitrary
bytes as text and decode them back. Neither is encryption or compression: anyone can reverse
them, and both make the data bigger (hex doubles it, base64 grows it by a third).

## Base64

Base64 turns every 3 bytes into 4 characters from a 64-character alphabet. Go has four ready
encodings in `encoding/base64`, from two choices: which alphabet, and whether to pad.

```go title="a/main.go"
package main

import (
	"encoding/base64"
	"fmt"
)

func main() {
	data := []byte("any carnal pleas?>~")
	fmt.Println(base64.StdEncoding.EncodeToString(data))
	fmt.Println(base64.RawStdEncoding.EncodeToString(data))
	fmt.Println(base64.URLEncoding.EncodeToString(data))
	fmt.Println(base64.RawURLEncoding.EncodeToString(data))

	for _, s := range []string{"", "f", "fo", "foo", "foob"} {
		fmt.Printf("%-5q -> %-8s %s\n", s, base64.StdEncoding.EncodeToString([]byte(s)), base64.RawStdEncoding.EncodeToString([]byte(s)))
	}

	enc := base64.StdEncoding
	out, err := enc.DecodeString("aGVsbG8=")
	fmt.Printf("%s %v\n", out, err)
	_, err = enc.DecodeString("aGVsbG8") // padding missing
	fmt.Println(err)
	_, err = enc.DecodeString("aGV$bG8=")
	fmt.Println(err)
	out, err = base64.RawStdEncoding.DecodeString("aGVsbG8")
	fmt.Printf("%s %v\n", out, err)
	_, err = base64.URLEncoding.DecodeString("a+b/")
	fmt.Println(err)

	fmt.Println(enc.EncodedLen(10), enc.DecodedLen(16))
}
```

```bash
go run ./a
```

```text
YW55IGNhcm5hbCBwbGVhcz8+fg==
YW55IGNhcm5hbCBwbGVhcz8+fg
YW55IGNhcm5hbCBwbGVhcz8-fg==
YW55IGNhcm5hbCBwbGVhcz8-fg
""    ->          
"f"   -> Zg==     Zg
"fo"  -> Zm8=     Zm8
"foo" -> Zm9v     Zm9v
"foob" -> Zm9vYg== Zm9vYg
hello <nil>
illegal base64 data at input byte 4
illegal base64 data at input byte 3
hello <nil>
illegal base64 data at input byte 1
16 12
```

| Encoding | Alphabet | Padding `=` | Used for |
|---|---|---|---|
| `base64.StdEncoding` | `A-Z a-z 0-9 + /` | yes | MIME e-mail, HTTP Basic auth, JSON `[]byte` fields, PEM |
| `base64.RawStdEncoding` | same | no | Same data where the length is known |
| `base64.URLEncoding` | `A-Z a-z 0-9 - _` | yes | Values in URLs and file names |
| `base64.RawURLEncoding` | same | no | JWT segments, tokens in URLs and cookies |

How it works: the input is split into 6-bit groups. When the length is not a multiple of 3 the
last group is short, and the padded form fills the output to a multiple of 4 with `=`
(`Zg==` for one byte, `Zm8=` for two, none for three). The raw forms leave the padding out. The
URL alphabet replaces `+` and `/`, which mean something in a URL, with `-` and `_`: the
difference shows in the third line, `8+` against `8-`.

Decoding must use the **same** encoding that was used to encode:

- `DecodeString` returns `illegal base64 data at input byte N` for a bad character, for
  missing padding with `StdEncoding`, and for `+` or `/` with `URLEncoding`. `N` is the offset of the
  first problem.
- The result is partially decoded when an error occurs; do not use it.
- `EncodedLen(n)` and `DecodedLen(n)` give output sizes for preallocating with
  `Encode(dst, src)` and `Decode(dst, src)`. `AppendEncode` and `AppendDecode` append to a slice.
- Decoding ignores `\r` and `\n`, so wrapped MIME text decodes.
- `enc.Strict()` additionally rejects non-zero trailing bits that a normal encoder never
  produces: `YR==` decodes with the standard decoder (to `a`) and fails with `Strict`.

### Real uses

```go title="c/main.go"
package main

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"strings"
)

type Token struct {
	Header  map[string]any
	Payload map[string]any
}

// decodeSegment reads one JWT-style segment: URL-safe base64 without padding.
func decodeSegment(seg string, out any) error {
	raw, err := base64.RawURLEncoding.DecodeString(seg)
	if err != nil {
		return fmt.Errorf("segment: %w", err)
	}
	return json.Unmarshal(raw, out)
}

func main() {
	tok := "eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.eyJzdWIiOiJhbm4iLCJleHAiOjE3OTk5OTk5OTl9.sig"
	parts := strings.Split(tok, ".")
	var t Token
	fmt.Println(decodeSegment(parts[0], &t.Header), t.Header)
	fmt.Println(decodeSegment(parts[1], &t.Payload), t.Payload)
	fmt.Println(decodeSegment("not base64!", &t.Header))

	// Basic auth header: standard encoding with padding.
	cred := base64.StdEncoding.EncodeToString([]byte("user:p@ss"))
	fmt.Println("Authorization: Basic " + cred)

	// Strict mode rejects non-canonical trailing bits.
	loose := base64.StdEncoding
	strict := base64.StdEncoding.Strict()
	_, e1 := loose.DecodeString("YR==")
	_, e2 := strict.DecodeString("YR==")
	fmt.Println(e1, e2)
}
```

```text
<nil> map[alg:none typ:JWT]
<nil> map[exp:1.799999999e+09 sub:ann]
segment: illegal base64 data at input byte 3
Authorization: Basic dXNlcjpwQHNz
<nil> illegal base64 data at input byte 2
```

The first two lines decode the header and payload of a JWT (a signed token): each segment is
JSON in `RawURLEncoding`. The `Authorization: Basic` header is `StdEncoding` of
`user:password`. JSON uses `StdEncoding` for `[]byte` fields ([[json]]).

> [!WARNING]
> Decoding a token's payload does not verify it. Anyone can write a payload that says
> `"sub":"admin"`. Only a checked signature ([[crypto-hash]]) says who made it. Likewise,
> base64 does not hide a secret: `dXNlcjpwQHNz` is `user:p@ss` to anyone who looks.

> [!WARNING]
> Mixing the encodings is the common bug. Symptom: `illegal base64 data at input byte N`
> for data that looks right, usually at a `-`, `_`, `+` or `/`, or at the end because of the
> padding. Fix: pick the encoding from the format you are reading (JWT: `RawURLEncoding`;
> Basic auth and e-mail: `StdEncoding`) and use the same one on both sides.

## Hex

`encoding/hex` writes each byte as two hexadecimal digits. It is the way to show hashes,
identifiers and binary dumps ([[crypto-hash]]).

```go title="b/main.go"
package main

import (
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"os"
	"strings"
)

func main() {
	b := []byte("Go!\x00\xff")
	s := hex.EncodeToString(b)
	fmt.Println(s)
	back, err := hex.DecodeString(s)
	fmt.Println(back, err)
	fmt.Println(hex.DecodeString("abc"))
	fmt.Println(hex.DecodeString("zz"))
	fmt.Println(hex.DecodeString("ABCDEF"))

	fmt.Print(hex.Dump([]byte("hello, hex dump! 0123456789")))

	// Streaming: encode while copying.
	enc := base64.NewEncoder(base64.StdEncoding, os.Stdout)
	enc.Write([]byte("stream "))
	enc.Write([]byte("of bytes"))
	enc.Close() // flushes the final partial group; do not forget
	fmt.Println()

	dec := base64.NewDecoder(base64.StdEncoding, strings.NewReader("c3RyZWFtIG9mIGJ5dGVz"))
	buf := make([]byte, 64)
	n, _ := dec.Read(buf)
	fmt.Printf("%s\n", buf[:n])
}
```

```text
476f2100ff
[71 111 33 0 255] <nil>
[171] encoding/hex: odd length hex string
[] encoding/hex: invalid byte: U+007A 'z'
[171 205 239] <nil>
00000000  68 65 6c 6c 6f 2c 20 68  65 78 20 64 75 6d 70 21  |hello, hex dump!|
00000010  20 30 31 32 33 34 35 36  37 38 39                 | 0123456789|
c3RyZWFtIG9mIGJ5dGVz
stream of bytes
```

- `hex.EncodeToString(b)` gives lower-case text, twice as long as the input;
  `hex.DecodeString(s)` reverses it and accepts upper or lower case.
- Errors are precise: an odd number of digits returns `encoding/hex: odd length hex string` (and
  the bytes decoded so far), and a bad digit names it: `invalid byte: U+007A 'z'`.
- `hex.Dump(b)` formats the classic hex dump: offset, 16 bytes in hex, then the printable
  characters. Use it for debugging binary protocols and files. `fmt.Printf("%x", b)` also
  prints hex, and `% x` puts spaces between bytes ([[fmt-verbs]]).

## Streaming

`base64.NewEncoder(enc, w)` returns an `io.WriteCloser`, and `base64.NewDecoder(enc, r)` an
`io.Reader`, so you can encode a large file while copying it, with the helpers from
[[io-composition]]. Both examples above use them. **Close the encoder**: base64 works in groups of
3 bytes, and `Close` writes the last, partial group. Without it, the output is cut short. `hex` has
`NewEncoder` and `NewDecoder` as well.

linkcheck stores page fingerprints as hex digests in [[step-8-state]].
