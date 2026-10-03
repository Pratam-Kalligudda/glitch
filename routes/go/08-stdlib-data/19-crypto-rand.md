---
title: Randomness and UUIDs
---
Go has two random number packages for two different jobs, and picking the wrong one is a
security bug. **`math/rand/v2`** is fast and good for simulations, shuffling, sampling, jitter and
tests, but its output can be predicted from its state. **`crypto/rand`** draws from the operating
system's secure source and is for anything an attacker must not guess: session tokens, API keys,
passwords, salts, nonces. A UUID, Go 1.27's new `uuid` package, is a third thing: an identifier
that is built from random bits (or a timestamp plus random bits).

## math/rand/v2: statistics, not secrets

```go title="a/main.go"
package main

import (
	"fmt"
	"math/rand/v2"
	"time"
)

func main() {
	// Top-level functions: randomly seeded, safe for concurrent use.
	fmt.Println(rand.IntN(10) < 10, rand.Float64() < 1)
	fmt.Println(rand.N(100) < 100)

	// A seeded generator is reproducible: tests, simulations, shuffles you can replay.
	r := rand.New(rand.NewPCG(1, 2))
	fmt.Println(r.IntN(100), r.IntN(100), r.IntN(100))
	r = rand.New(rand.NewPCG(1, 2))
	fmt.Println(r.IntN(100), r.IntN(100), r.IntN(100))

	// Shuffle and Perm.
	items := []string{"a", "b", "c", "d", "e"}
	r = rand.New(rand.NewPCG(7, 7))
	r.Shuffle(len(items), func(i, j int) { items[i], items[j] = items[j], items[i] })
	fmt.Println(items, r.Perm(5))

	// N works on any integer type, including durations.
	d := rand.N(time.Second)
	fmt.Println(d >= 0 && d < time.Second)
}
```

```bash
go run ./a
```

```text
true true
true
76 61 78
76 61 78
[a b d c e] [4 0 3 2 1]
true
```

- The **top-level functions** (`rand.IntN`, `rand.Float64`, `rand.N`, `rand.Shuffle`, `rand.Perm`)
  use a generator that Go seeds randomly at start-up and that is safe for concurrent use. Each
  program run gives different numbers. You never call `Seed`; `math/rand/v2` has no `Seed` at all.
- `rand.IntN(n)` returns `[0, n)`; the name ends in `N` for "below n" and panics if `n <= 0`.
  `rand.N(x)` is the generic version for any integer type, so `rand.N(time.Second)` gives a random
  duration, useful for jitter in retries ([[rate-limiting]]). Go 1.27 adds the same as a method,
  `(*Rand).N`.
- **A seeded generator is reproducible.** `rand.New(rand.NewPCG(1, 2))` always produces `76 61 78`
  here. This is the right tool for tests and simulations that must be replayable: print the seed
  when a test fails and rerun with it. `rand.NewChaCha8(seed)` is the stronger, slower source
  (a 32-byte seed).
- `Shuffle(n, swap)` shuffles any sequence by index; `Perm(n)` returns a random permutation of
  `0..n-1`. Both are uniform and use Fisher-Yates.

`math/rand` (without `/v2`) still exists, with a different API (`Intn`, `Seed`), and `v2` is the
package to use in new code: simpler names, better algorithms, no global seeding to get wrong.

> [!WARNING]
> Never use `math/rand` or `math/rand/v2` for tokens, passwords, keys or anything an attacker
> benefits from guessing. A PCG generator is **predictable**: seen a few outputs, an attacker can
> compute the state and every later value; a fixed seed makes every value known. Symptom: session
> IDs or reset links that can be guessed, with nothing wrong in testing. Fix: `crypto/rand`, below.

## crypto/rand: secrets

```go title="b/main.go"
package main

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"math/big"
)

func main() {
	// 32 random bytes: a key or token, as hex.
	key := make([]byte, 32)
	rand.Read(key) // never returns an error in Go 1.24 and later
	fmt.Println(len(hex.EncodeToString(key)))

	// Text: a ready-made secret string (Go 1.24).
	tok := rand.Text()
	fmt.Println(len(tok), tok)

	// A uniformly random integer in [0, max).
	n, err := rand.Int(rand.Reader, big.NewInt(1000))
	fmt.Println(n.Cmp(big.NewInt(1000)) < 0, err)
}
```

```text
64
26 PP5Y3N6LN3GX7TVDXF5TB7DZSI
true <nil>
```

(The random values differ on every run.)

- `rand.Read(b)` fills `b` with secure random bytes. Since Go 1.24 it **never returns an error**:
  if the operating system cannot supply randomness the program crashes, which is the safe
  response, so you do not need an error branch. (The `n, err` results exist only to match
  `io.Reader`.)
- **`rand.Text()`** (Go 1.24) returns a ready-to-use secret string: base32 characters with at least
  128 bits of randomness, 26 characters today. Use it for tokens, one-time codes and temporary
  passwords, with no encoding step.
- For a token of your own length: read bytes and encode with `base64.RawURLEncoding` or hex
  ([[base64-hex]]); 16 bytes (128 bits) is the usual minimum, 32 is comfortable.
- `rand.Int(rand.Reader, max)` returns a uniformly distributed `*big.Int` in `[0, max)`, the way to
  pick a random number without modulo bias. `rand.Reader` is the underlying `io.Reader` for other
  APIs that want one.

Never reduce random bytes with `%`: `int(b) % 10` favours the small digits, because 256 is not a
multiple of 10. Use `rand.Int`, or `math/rand/v2` when the value is not secret.

## UUIDs (Go 1.27)

A **UUID** (universally unique identifier, RFC 9562) is a 128-bit value, written as 32 hex digits
in five groups: `f81d4fae-7dec-11d0-a765-00a0c91e6bf6`. Two systems can create UUIDs without
talking to each other and still not collide, which is why they are used as database keys, request
and run IDs. Go 1.27 adds the package **`uuid`** to the standard library. The import path has no
domain and no `/v1`: it is just `uuid`, like `errors`.

```go title="c/main.go"
package main

import (
	"encoding/json"
	"fmt"
	"slices"
	"strings"
	"time"
	"uuid"
)

type Run struct {
	ID    uuid.UUID `json:"id"`
	Start string    `json:"start"`
}

func main() {
	a := uuid.New() // same as NewV4
	fmt.Println(a)
	fmt.Println("version digit:", a.String()[14:15], "variant digit in 89ab:", strings.Contains("89ab", a.String()[19:20]))

	v7a := uuid.NewV7()
	time.Sleep(2 * time.Millisecond)
	v7b := uuid.NewV7()
	fmt.Println(v7a)
	fmt.Println(v7b)
	fmt.Println("v7 sorts by time:", v7a.Compare(v7b), v7a.String() < v7b.String())

	// Zero values and parsing.
	fmt.Println(uuid.Nil(), uuid.Max())
	p, err := uuid.Parse("urn:uuid:F81D4FAE-7DEC-11D0-A765-00A0C91E6BF6")
	fmt.Println(p, err)
	_, err = uuid.Parse("not-a-uuid")
	fmt.Println(err)
	fmt.Println(p == uuid.MustParse("f81d4fae7dec11d0a76500a0c91e6bf6"))

	// It is a [16]byte: comparable, usable as a map key, and text-marshalled.
	seen := map[uuid.UUID]bool{p: true}
	fmt.Println(seen[p], seen[a])
	out, _ := json.Marshal(Run{ID: p, Start: "now"})
	fmt.Println(string(out))
	var back Run
	fmt.Println(json.Unmarshal(out, &back), back.ID == p)

	ids := []uuid.UUID{uuid.NewV7(), uuid.NewV7(), uuid.NewV7()}
	fmt.Println(slices.IsSortedFunc(ids, uuid.UUID.Compare))
}
```

```text
aea51921-5364-4956-b071-de66eee14195
version digit: 4 variant digit in 89ab: true
01a1020a-7dc7-72f5-a9e8-157304d186a2
01a1020a-7dca-741f-9e34-2dce49d28171
v7 sorts by time: -1 true
00000000-0000-0000-0000-000000000000 ffffffff-ffff-ffff-ffff-ffffffffffff
f81d4fae-7dec-11d0-a765-00a0c91e6bf6 <nil>
invalid uuid
true
true false
{"id":"f81d4fae-7dec-11d0-a765-00a0c91e6bf6","start":"now"}
<nil> true
true
```

(The IDs differ on every run.)

| API | Meaning |
|---|---|
| `uuid.New()` | A new UUID using the library's recommended algorithm. Today it equals `NewV4` |
| `uuid.NewV4()` | Version 4: 122 random bits |
| `uuid.NewV7()` | Version 7: a 48-bit millisecond timestamp, then at least 62 random bits. **Sorts in creation order** |
| `uuid.Parse(s)`, `MustParse(s)` | Accept the dashed form, `{...}`, `urn:uuid:...` and 32 plain hex digits, any case |
| `uuid.Nil()`, `uuid.Max()` | All zeros, all ones |
| `u.String()` | Lower-case dashed form |
| `u.Compare(v)` | `-1`, `0` or `1` by the bytes |

What to read from the example:

- `uuid.UUID` is `[16]byte`, so it is **comparable**: use `==` and use it as a map key. It
  implements `MarshalText` and `UnmarshalText`, which is why it appears as a JSON string
  ([[json-custom]]) and works as a text value in other formats, with no extra code.
- The `4` in `...-49bd-...` is the **version digit** and the first digit of the fourth group is
  one of `8`, `9`, `a`, `b`, the **variant**. They are fixed, which is why version 4 has 122 random
  bits rather than 128.
- Both generators draw their random bits from a cryptographically secure source, so a v4 UUID is
  unpredictable.
- **Choose v7 when the ID goes into an index.** Random v4 keys land at random places in a
  B-tree index, which slows inserts as the table grows; v7 keys arrive in time order and append
  at the end. `NewV7` returns increasing values, except if the system clock moves backwards.
  The cost: a v7 UUID **reveals when it was made**, which can be a privacy leak; use v4 for IDs
  that are shown to others and should not leak timing.
- Do not use a UUID as a secret or a password-reset token. It is an identifier, not an
  authenticator: v7's first 48 bits are guessable time. Use `crypto/rand.Text()`.

> [!NOTE]
> Before 1.27 the usual choice was `github.com/google/uuid`. Its types are not the standard
> ones, so mixing the two needs a conversion (`uuid.UUID(g)` works because both are `[16]byte`).
> New code can use the standard package and drop the dependency.

| Need | Use |
|---|---|
| A secret token, key, nonce, salt | `crypto/rand` (`Read`, `Text`) |
| A unique ID for a row, a request, a run | `uuid.NewV7()` for indexed keys, `uuid.New()` otherwise |
| A number for a game, shuffle, sample or jitter | `math/rand/v2` |
| A replayable sequence for a test | `rand.New(rand.NewPCG(seed1, seed2))` |
| A random duration | `rand.N(time.Second)` |

linkcheck gives every crawl a run ID from `uuid.NewV7()` so saved states sort by time, in
[[step-8-state]].
