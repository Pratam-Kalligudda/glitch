---
title: Hashing and HMAC
---
A **hash function** turns any amount of data into a short, fixed-size value, its **digest**.
The same input always gives the same digest, a one-byte change gives a completely different one,
and a **cryptographic** hash makes it infeasible to find two inputs with the same digest or to
recover the input from the digest. Hashes identify and compare data: duplicate detection, cache
keys, file integrity, content addresses. An **HMAC** adds a secret key, so only someone with the key
can produce a valid digest: it authenticates a message. This stop covers both, and what a hash is
not good for.

## Digests

```go title="a/main.go"
package main

import (
	"crypto/md5"
	"crypto/sha1"
	"crypto/sha256"
	"crypto/sha512"
	"encoding/hex"
	"fmt"
	"hash/crc32"
	"hash/fnv"
	"io"
	"strings"
)

func main() {
	data := []byte("hello")

	sum := sha256.Sum256(data) // [32]byte
	fmt.Println(hex.EncodeToString(sum[:]))
	fmt.Printf("%x\n", sha512.Sum512_256(data))
	fmt.Printf("%x\n", sha1.Sum(data))
	fmt.Printf("%x\n", md5.Sum(data))
	fmt.Println(crc32.ChecksumIEEE(data))

	// Hash a stream: hash.Hash is an io.Writer.
	h := sha256.New()
	io.Copy(h, strings.NewReader("hel"))
	io.WriteString(h, "lo")
	fmt.Printf("%x\n", h.Sum(nil))
	fmt.Println(h.Size(), h.BlockSize())

	f := fnv.New64a()
	f.Write(data)
	fmt.Println(f.Sum64())

	// A one-byte change changes everything.
	a := sha256.Sum256([]byte("hello"))
	b := sha256.Sum256([]byte("hellp"))
	fmt.Printf("%x\n%x\n", a[:6], b[:6])
}
```

```bash
go run ./a
```

```text
2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824
e30d87cfa2a75db545eac4d61baf970366a8357c7f72fa95b52d0accb698f13a
aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d
5d41402abc4b2a76b9719d911017c592
907060870
2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824
32 64
11831194018420276491
2cf24dba5fb0
fdd7585e08c4
```

| Package | Digest size | Use |
|---|---|---|
| `crypto/sha256` (`Sum256`, `Sum224`, `New`) | 32 bytes | The default choice for integrity, identity, signatures |
| `crypto/sha512` (`Sum512`, `Sum384`, `Sum512_256`) | 64, 48, 32 bytes | Larger or faster on 64-bit CPUs |
| `crypto/sha3` (Go 1.24) | 28 to 64 bytes, plus SHAKE | The newer SHA-3 family |
| `crypto/sha1`, `crypto/md5` | 20, 16 bytes | **Broken** for security. Fine as a checksum where the format demands it (Git, ETags) |
| `hash/crc32`, `hash/crc64`, `hash/adler32` | 4 or 8 bytes | Error detection for accidents, not attacks |
| `hash/fnv`, `hash/maphash` | 4, 8 bytes | Hash tables, sharding: fast, not secret, not collision-safe against an attacker |

How it works:

- `sha256.Sum256(data)` computes the digest of a byte slice in one call and returns a `[32]byte`
  array. Slice it (`sum[:]`) to pass it as a `[]byte`, and print it with `%x` or `hex.EncodeToString`
  ([[base64-hex]]). Digests are bytes, not text: compare them as bytes or as hex of the same case.
- **`sha256.New()` returns a `hash.Hash`**, an `io.Writer` with `Sum(b)`, `Reset()`, `Size()` and
  `BlockSize()`. You write data in any number of pieces, and `h.Sum(nil)` returns the digest of
  everything written. Writing `"hel"` and then `"lo"` equals hashing `"hello"` (the identical digest
  in the output). `Sum(b)` **appends** to `b`; pass `nil`. It does not reset the hash.
- Hash writers never return an error from `Write`.

## Hashing files and streams

Because a hash is an `io.Writer`, `io.Copy` hashes any reader in constant memory, whatever its size:

```go title="b/main.go"
package main

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
)

// fileSHA256 hashes a file in constant memory.
func fileSHA256(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

func main() {
	dir, err := os.MkdirTemp("", "hash-*")
	if err != nil {
		log.Fatal(err)
	}
	defer os.RemoveAll(dir)

	paths := map[string]string{"a.txt": "same page body", "b.txt": "same page body", "c.txt": "different"}
	seen := map[string]string{} // digest -> first file
	for _, name := range []string{"a.txt", "b.txt", "c.txt"} {
		p := filepath.Join(dir, name)
		os.WriteFile(p, []byte(paths[name]), 0o644)
		sum, err := fileSHA256(p)
		if err != nil {
			log.Fatal(err)
		}
		if first, dup := seen[sum]; dup {
			fmt.Printf("%s duplicates %s (%s...)\n", name, first, sum[:8])
			continue
		}
		seen[sum] = name
		fmt.Printf("%s %s...\n", name, sum[:8])
	}
}
```

```text
a.txt 5d0b8875...
b.txt duplicates a.txt (5d0b8875...)
c.txt 9d6f965a...
```

Digests make duplicate detection cheap: two pages with the same SHA-256 have, for all practical
purposes, the same content, so linkcheck stores the digest of each page body and flags
duplicates in [[step-8-state]]. Use `io.TeeReader(r, h)` to hash data while you also consume it, or
`io.MultiWriter(file, h)` to write and hash together ([[io-composition]]).

## HMAC: a keyed hash

A plain hash proves nothing about who made the message: anyone can compute `sha256(msg)`. An
**HMAC** mixes a secret key into the hash. Only a holder of the key can create a valid tag, and
anyone with the key can check one. It is the building block of signed cookies, webhook signatures
(GitHub, Stripe) and API request signing.

```go title="c/main.go"
package main

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
)

func sign(key, msg []byte) []byte {
	m := hmac.New(sha256.New, key)
	m.Write(msg)
	return m.Sum(nil)
}

func verify(key, msg, mac []byte) bool {
	return hmac.Equal(sign(key, msg), mac) // constant-time compare
}

func main() {
	key := []byte("server-secret-key")
	msg := []byte(`{"user":"ann","exp":1799999999}`)

	mac := sign(key, msg)
	fmt.Println(hex.EncodeToString(mac))
	fmt.Println(verify(key, msg, mac))
	fmt.Println(verify(key, []byte(`{"user":"admin","exp":1799999999}`), mac))
	fmt.Println(verify([]byte("other key"), msg, mac))

	// A plain hash is not a MAC: anyone can compute it.
	plain := sha256.Sum256(msg)
	fmt.Println(verify(key, msg, plain[:]))
}
```

```text
b1344ab6bbc40b8eecb3e6a57feaa5fa068f356f60e7b2a99c288f04b26db6a6
true
false
false
false
```

- `hmac.New(sha256.New, key)` takes a **function that creates the hash** (note: `sha256.New` without
  parentheses) and the key.
- Changing the message (`admin` instead of `ann`), using another key, or substituting a plain hash
  each fails verification.
- **Compare with `hmac.Equal`**, which takes the same time no matter where the first difference is.
  `==` and `bytes.Equal` return early at the first differing byte, which leaks how much of a guessed
  tag was right: a **timing attack**. For other secret comparisons use
  `crypto/subtle.ConstantTimeCompare`.

> [!WARNING]
> Checking a signature or token with `==` or `bytes.Equal`. Symptom: none in testing; an attacker
> who can measure response times recovers a valid tag byte by byte. Fix: `hmac.Equal` or
> `subtle.ConstantTimeCompare` for every comparison of secret-derived values.

> [!WARNING]
> Hashing passwords with SHA-256 (or MD5, SHA-1). These are built to be fast, so an attacker with
> a stolen database tries billions of guesses per second. Symptom: none, until a breach. Fix: use a
> deliberately slow, salted **password hashing** function: bcrypt, scrypt or argon2 from
> `golang.org/x/crypto`, or `crypto/pbkdf2` from the standard library (Go 1.24):

```go title="d/main.go"
package main

import (
	"crypto/pbkdf2"
	"crypto/sha256"
	"crypto/subtle"
	"fmt"
	"time"
)

func main() {
	salt := []byte("random-per-user-salt")
	t := time.Now()
	key, err := pbkdf2.Key(sha256.New, "correct horse", salt, 600_000, 32)
	if err != nil {
		fmt.Println(err)
		return
	}
	elapsed := time.Since(t)
	fmt.Printf("%x\n", key[:8])
	fmt.Println("deliberately slow:", elapsed > time.Millisecond)

	again, _ := pbkdf2.Key(sha256.New, "correct horse", salt, 600_000, 32)
	fmt.Println(subtle.ConstantTimeCompare(key, again) == 1)
}
```

```text
889cd574fe1ae511
deliberately slow: true
true
```

`pbkdf2.Key(hash, password, salt, iterations, keyLength)` repeats the hash `iterations` times,
which is what makes each guess expensive. Use a long random **salt** per user (from
`crypto/rand`, see [[crypto-rand]]) so two users with the same password get different keys, and
store the salt and the iteration count next to the result. The count is a cost you raise over time;
OWASP's current guidance for PBKDF2 with HMAC-SHA-256 is 600,000 iterations; check it again when you write
real code. OWASP prefers argon2id, then scrypt, and keeps PBKDF2 for cases that need FIPS-140 compliance.

## Choosing

| Goal | Tool |
|---|---|
| Content identity, dedupe, file integrity | SHA-256 |
| Prove a message came from a key holder | HMAC-SHA-256, compared with `hmac.Equal` |
| Store passwords | argon2id, bcrypt, scrypt or PBKDF2, with a salt |
| Hash table key or shard choice | `hash/maphash` or FNV; never for secrets |
| Catch accidental corruption | CRC32 |
| Encrypt data | not a hash: use an authenticated cipher such as AES-GCM from `crypto/aes` and `crypto/cipher` |

> [!NOTE]
> A hash is one-way and keyless; it does not hide short or guessable inputs. A digest of a
> phone number or an e-mail address can be reversed by hashing every candidate. If the input space
> is small, hash with a secret key (HMAC) instead.
