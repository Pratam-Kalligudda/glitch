---
title: Fuzzing
done_when: "`go test -fuzz=FuzzHost` finds a failing input, writes it under testdata/fuzz, a plain `go test` replays it, and the test passes after your fix."
---
A table test checks the inputs you thought of. **Fuzzing** checks inputs you did not. A fuzz test states a property that must hold for every input, such as "this function never panics" or "normalising twice gives the same result as normalising once". The go tool then generates thousands of inputs per second, starting from examples you supply and mutating them, and uses code coverage to steer toward inputs that reach new code. When an input breaks the property, it is saved to a file, and from then on it is an ordinary regression test.

Fuzzing is built into `go test` and needs no extra tools.

## A function with a bug nobody wrote a test for

linkcheck needs the host of a URL. This helper looks fine and passes its table test. It uses the `urlnorm` package from [[table-tests]] (one `host.go` file is added to it):

```text title="go.mod"
module example.com/fuzz-demo

go 1.27
```

```go title="urlnorm/host.go"
package urlnorm

import "strings"

// Host returns the host part of an absolute URL: everything between "://"
// and the next "/".
func Host(raw string) string {
	rest := raw[strings.Index(raw, "://")+3:]
	host, _, _ := strings.Cut(rest, "/")
	return host
}
```

```go title="urlnorm/host_test.go"
package urlnorm

import "testing"

func TestHost(t *testing.T) {
	tests := map[string]string{
		"https://go.dev/doc/":   "go.dev",
		"http://example.com":    "example.com",
		"http://localhost:8080": "localhost:8080",
	}
	for in, want := range tests {
		if got := Host(in); got != want {
			t.Errorf("Host(%q) = %q, want %q", in, got, want)
		}
	}
}

func FuzzHost(f *testing.F) {
	f.Add("https://go.dev/doc/")
	f.Add("http://example.com")

	f.Fuzz(func(t *testing.T, raw string) {
		Host(raw) // property: it must not panic, whatever the input
	})
}
```

`TestHost` is an ordinary test, `FuzzHost` is the fuzz test. They differ in three ways:

- the function is named `FuzzXxx` and takes a `*testing.F`;
- `f.Add(...)` registers **seed** inputs, the starting corpus;
- `f.Fuzz(func(t *testing.T, raw string) {...})` is the body that runs for each input. Its arguments after `t` are the fuzzed values, and they must be of the supported types: `string`, `[]byte`, `bool`, the integer and float types, `rune` and `byte`. A body may take several.

Run it as a normal test first. Without `-fuzz`, `go test` runs only the seeds (and saved failures, below), which makes a fuzz test cheap enough to keep in every CI run:

```bash
go test ./urlnorm
```

```text
ok  	example.com/fuzz-demo/urlnorm	0.433s
```

Now turn the fuzzer on:

```bash
go test -fuzz=FuzzHost -fuzztime=30s ./urlnorm
```

```text
fuzz: elapsed: 0s, gathering baseline coverage: 0/2 completed
fuzz: elapsed: 0s, gathering baseline coverage: 2/2 completed, now fuzzing with 12 workers
fuzz: minimizing 27-byte failing input file
fuzz: elapsed: 0s, minimizing
--- FAIL: FuzzHost (0.18s)
    --- FAIL: FuzzHost (0.00s)
        testing.go:2076: panic: runtime error: slice bounds out of range [2:0]
            goroutine 434 [running]:
            ...
            example.com/fuzz-demo/urlnorm.Host({0x0, 0x0})
            	.../urlnorm/host.go:8 +0x99
            example.com/fuzz-demo/urlnorm.FuzzHost.func1(0x0?, {0x0?, 0x0?})
            	.../urlnorm/host_test.go:23 +0x3b
            ...

    Failing input written to testdata\fuzz\FuzzHost\5838cdfae7b16cde
    To re-run:
    go test -run=FuzzHost/5838cdfae7b16cde
FAIL
exit status 1
FAIL	example.com/fuzz-demo/urlnorm	0.630s
```

In under a second the fuzzer found a crash and **minimised** it: the failing input began as 27 bytes and was shrunk to the shortest one that still fails. The empty string. `strings.Index("", "://")` is -1, so the slice is `raw[2:]` of an empty string. The stack points at `host.go:8`, and the last lines tell you where the input went and how to run it again.

## How it works

**The corpus.** A fuzz test has two sets of inputs. The **seed corpus** is made of the `f.Add` calls and the files under `testdata/fuzz/<FuzzName>/` in the package directory. Both run on every plain `go test`. The **generated corpus** is what the fuzzer builds while it runs; it holds the "interesting" inputs, those that reached new code, and lives in the Go build cache (`go env GOCACHE`, subfolder `fuzz`), not in your repository. `go clean -fuzzcache` deletes it. The progress lines report it: `new interesting: 30 (total: 429)` is the number added this run and the size of the corpus.

**A failure is saved as a file you commit.** The failing input went to `testdata/fuzz/FuzzHost/5838cdfae7b16cde`, a file named after a hash of its content:

```text title="urlnorm/testdata/fuzz/FuzzHost/5838cdfae7b16cde"
go test fuzz v1
string("")
```

The first line is a version header; each following line is one argument of the fuzz function, written as a Go literal. You can write such files by hand to add a seed that is awkward to express with `f.Add`.

**Saved failures replay by themselves.** A plain `go test` now fails, in the subtest named after the file, without any fuzzing:

```bash
go test ./urlnorm
```

```text
--- FAIL: FuzzHost (0.00s)
    --- FAIL: FuzzHost/5838cdfae7b16cde (0.00s)
panic: runtime error: slice bounds out of range [2:0] [recovered, repanicked]
...
```

Select just that case with `go test -run=FuzzHost/5838cdfae7b16cde`, as the fuzzer suggested. That makes the bug reproducible for anyone, with no randomness, and the file stays in the repository as a permanent regression test. Fix the code (`strings.Cut` reports whether the separator exists, so there is no index arithmetic to get wrong):

```go title="urlnorm/host.go"
package urlnorm

import "strings"

// Host returns the host part of an absolute URL: everything between "://"
// and the next "/". It returns "" when raw has no "://".
func Host(raw string) string {
	_, rest, ok := strings.Cut(raw, "://")
	if !ok {
		return ""
	}
	host, _, _ := strings.Cut(rest, "/")
	return host
}
```

```bash
go test -v -run FuzzHost ./urlnorm
```

```text
--- PASS: FuzzHost (0.00s)
    --- PASS: FuzzHost/seed#0 (0.00s)
    --- PASS: FuzzHost/seed#1 (0.00s)
    --- PASS: FuzzHost/5838cdfae7b16cde (0.00s)
PASS
ok  	example.com/fuzz-demo/urlnorm	0.406s
```

The three subtests are the two `f.Add` seeds and the saved failure. Then fuzz again to look for the next one: `go test -fuzz=FuzzHost -fuzztime=10s ./urlnorm` ended with `PASS` after 1.6 million executions.

**Running the fuzzer.**

| Flag | Does |
|---|---|
| `-fuzz=FuzzName` | Fuzz the test matching the regular expression. It must match exactly one fuzz test, in exactly one package |
| `-fuzztime=30s` or `-fuzztime=1000x` | Stop after a duration, or after that many executions. The default is to run until a failure or Ctrl-C |
| `-fuzzminimizetime=10s` | Time to spend shrinking a failing input |
| `-parallel=n` | Number of fuzzing workers (the default is `GOMAXPROCS`) |

A pattern that matches two tests is refused: `go test -fuzz=Fuzz` printed `testing: will not fuzz, -fuzz matches more than one fuzz test: [FuzzNormalize FuzzHost]`.

## Properties worth fuzzing

A fuzz test cannot say what the right answer is for a random input, so it checks something that must always be true:

- **It does not panic or hang.** The simplest property, and the one above.
- **Round trip:** `Decode(Encode(x)) == x`.
- **Idempotence:** doing the operation twice equals doing it once. This is the natural property for a normaliser.
- **Two implementations agree,** such as a fast version and an obvious slow one.
- **An invariant of the output:** the result is always valid UTF-8, always sorted, never longer than the input.

`FuzzNormalize` checks that `Normalize` is idempotent. If URLs are normalised so that duplicates are visited once ([[step-2-crawl]]), then `Normalize(Normalize(x))` must equal `Normalize(x)`, or two spellings of one page end up in different places.

```go title="urlnorm/fuzz_test.go"
package urlnorm

import "testing"

func FuzzNormalize(f *testing.F) {
	// Seeds: inputs worth trying first.
	f.Add("https://go.dev/doc/")
	f.Add("HTTP://Example.COM:80/a#frag")
	f.Add("https://go.dev")
	f.Add("mailto:gopher@go.dev")
	f.Add("http://[::1]:8080/")

	f.Fuzz(func(t *testing.T, raw string) {
		once, err := Normalize(raw)
		if err != nil {
			return // rejecting an input is fine
		}
		// Property: normalising a normalised URL changes nothing.
		twice, err := Normalize(once)
		if err != nil {
			t.Fatalf("Normalize(%q) = %q, but normalising that fails: %v", raw, once, err)
		}
		if twice != once {
			t.Errorf("not idempotent: Normalize(%q) = %q, then %q", raw, once, twice)
		}
	})
}
```

The last seed, `http://[::1]:8080/`, is an IPv6 address. Without the seed, a 20-second run and then a 120-second run of the fuzzer both ended with `PASS`: the fuzzer did not find this bug by itself. With the seed, a plain `go test` fails:

```text
--- FAIL: FuzzNormalize (0.00s)
    --- FAIL: FuzzNormalize/seed#4 (0.00s)
        fuzz_test.go:21: Normalize("http://[::1]:8080/") = "http://::1:8080/", but normalising that fails: parse "http://::1:8080/": invalid port "::1:8080" after host
FAIL
FAIL	example.com/fuzz-demo/urlnorm	0.419s
FAIL
```

The property was right and the code was wrong: `u.Hostname()` strips the brackets from an IPv6 address, and `Normalize` forgot to put them back. The fix, in `urlnorm.go` after the line that lowercases the host:

```diff
 	host := strings.ToLower(u.Hostname())
+	if strings.Contains(host, ":") { // an IPv6 literal needs its brackets back
+		host = "[" + host + "]"
+	}
 	port := u.Port()
```

After it, `go test ./urlnorm` is `ok`. This is the honest picture of fuzzing: it is very good at crashes with short inputs (the empty string took a fraction of a second) and weaker at inputs that need a precise structure, which you give it as seeds. Think of seeds as the part of the input space you already know matters.

> [!WARNING]
> Three mistakes with fuzz tests. (1) **A body that is not deterministic or depends on state:** it uses the clock, a global or the network, so a failure cannot be replayed. Symptom: a saved input that passes on the second run. Fix: keep the body a pure function of its arguments. (2) **A slow body.** The fuzzer's value is volume; a body that takes 50 ms runs 20 times a second per worker, so it finds little. Fix: fuzz the small function, not the whole program. (3) **Committing nothing.** The generated corpus lives in the cache and a failure lives in `testdata/fuzz`. Symptom: a colleague, or CI, cannot reproduce the failure. Fix: commit the files under `testdata/fuzz`.

> [!NOTE]
> Fuzzing is a search, not a proof. `PASS` means "no failure found in this time". Run it for longer on a schedule, such as nightly for a few minutes, while `go test` in CI runs just the seeds and the saved failures. The Go documentation on fuzzing, <https://go.dev/doc/security/fuzz>, has the full list of supported argument types and the corpus file format.

linkcheck fuzzes URL normalisation in [[step-6-tests]], and any property you add there becomes a cheap test of the crawl's central assumption: one page, one key.
