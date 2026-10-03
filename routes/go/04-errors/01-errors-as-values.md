---
title: Errors as values
done_when: "Every function you write that can fail returns error as its last result, returns zero values with a non-nil error, and every call site checks the error before using the other results."
---
Go has no exceptions for ordinary failures. A function that can fail returns an extra
result of the built-in interface type `error`:

```go
type error interface {
	Error() string
}
```

`nil` means success; anything else is a failure, and its `Error` method describes it. The
caller checks it with an `if` right after the call. That is more typing than `try`/`catch`,
and it is deliberate: every place a failure can happen is visible in the code, the caller
decides what to do at each one, and an error is an ordinary value you can store, compare,
pass to a function or put in a slice. Rob Pike's phrase for this is "errors are values".

```go title="main.go"
package main

import (
	"errors"
	"fmt"
	"strconv"
	"strings"
)

type Config struct {
	Workers  int
	MaxDepth int
}

// parseLine splits "key = value". On failure it returns zero values and a non-nil error.
func parseLine(line string) (key, value string, err error) {
	k, v, ok := strings.Cut(line, "=")
	if !ok {
		return "", "", errors.New("missing '='")
	}
	k, v = strings.TrimSpace(k), strings.TrimSpace(v)
	if k == "" {
		return "", "", errors.New("empty key")
	}
	return k, v, nil
}

func parseConfig(text string) (Config, error) {
	cfg := Config{Workers: 4, MaxDepth: 3} // defaults
	for i, line := range strings.Split(strings.TrimSpace(text), "\n") {
		key, value, err := parseLine(line)
		if err != nil {
			return Config{}, fmt.Errorf("line %d: %v", i+1, err)
		}
		n, err := strconv.Atoi(value)
		if err != nil {
			return Config{}, fmt.Errorf("line %d: %s: %v", i+1, key, err)
		}
		switch key {
		case "workers":
			cfg.Workers = n
		case "max_depth":
			cfg.MaxDepth = n
		default:
			return Config{}, fmt.Errorf("line %d: unknown key %q", i+1, key)
		}
	}
	return cfg, nil
}

func main() {
	inputs := []string{
		"workers = 8\nmax_depth = 5",
		"workers = 8\nmax_depth 5",
		"workers = eight",
		"retries = 2",
	}
	for _, in := range inputs {
		cfg, err := parseConfig(in)
		if err != nil {
			fmt.Println("error:", err)
			continue
		}
		fmt.Printf("ok: %+v\n", cfg)
	}

	// The error is a value: you can store it, compare it, pass it around.
	_, err := strconv.Atoi("eight")
	fmt.Printf("type %T, message %q\n", err, err.Error())
}
```

```bash
go run .
```

```text
ok: {Workers:8 MaxDepth:5}
error: line 2: missing '='
error: line 1: workers: strconv.Atoi: parsing "eight": invalid syntax
error: line 1: unknown key "retries"
type *strconv.NumError, message "strconv.Atoi: parsing \"eight\": invalid syntax"
```

## How it works

- **`error` is the last result.** By convention, always. Tools and readers rely on it.
- **On failure, the other results are zero values.** `parseLine` returns `"", "", err`;
  `parseConfig` returns `Config{}`, not the half-filled `cfg`. Callers must not use the
  other results when `err != nil`, and returning zero values makes accidental use obvious
  rather than subtly wrong.
- **Check immediately, return early.** Each `if err != nil` sits right after its call and
  returns. The successful path continues down the left margin without nesting; this is the
  standard shape of Go code.
- **`errors.New(text)`** creates an error with a fixed message. **`fmt.Errorf(format,
  args...)`** builds one with formatting, here adding the line number and key so the
  message says where the failure happened. These errors use `%v`, which copies the inner
  message as text; [[wrapping]] replaces it with `%w`, which also keeps the inner error so
  callers can inspect it.
- **Errors carry types.** `strconv.Atoi` returns a `*strconv.NumError`, a struct with
  fields for the function, the input and the cause. Its `Error` method produces the
  message. [[sentinel-typed]] shows how to define such types yourself.
- **`err` is reused.** `key, value, err := parseLine(line)` declares `err`; the next
  `n, err := strconv.Atoi(value)` declares only `n` and assigns to the existing `err`,
  because `:=` needs at least one new name on the left.

## Error message style

Go's code review conventions give error strings a consistent shape, because they are
usually printed inside other messages:

| Rule | Why | Example |
|---|---|---|
| Lower case first letter | It is usually not the start of a sentence | `missing '='`, not `Missing '='` |
| No trailing punctuation or newline | Another layer will append `: ...` after it | `unknown key "retries"` |
| Say what failed and with what input | The reader of the log has no other context | `line 1: workers: strconv.Atoi: parsing "eight": invalid syntax` |
| No "error:", "failed to" prefixes | Every error is a failure; the words add length, not information | `open config.yaml: ...`, not `failed to open config.yaml: ...` |

A chain of `outer: inner: innermost` reads like a path from the operation the user asked
for down to the root cause.

## Some functions return a value *and* an error

The rule "do not use the results when `err != nil`" has a documented exception you met in
[[io-composition]]: `io.Reader.Read` may return `n > 0` together with an error, and you
must process those `n` bytes. When a function does this, its documentation says so. If it
does not say so, treat the other results as meaningless on error.

## Ignoring an error

Discarding an error with `_` turns a loud failure into a silent wrong value. This program
has a typo in its configured port:

```go title="main.go"
package main

import (
	"fmt"
	"net"
	"strconv"
)

func main() {
	portText := "80a" // a typo in a config file

	port, _ := strconv.Atoi(portText) // error discarded: port is 0
	ln, err := net.Listen("tcp", "127.0.0.1:"+strconv.Itoa(port))
	if err != nil {
		fmt.Println("listen:", err)
		return
	}
	fmt.Println("listening on", ln.Addr(), "- not on port 80")
	ln.Close()
}
```

```text
listening on 127.0.0.1:53313 - not on port 80
```

`Atoi` failed and returned 0, and port 0 asks the operating system for any free port (the
number varies per run). Nothing failed loudly; the program is simply wrong.

> [!WARNING]
> Ignoring an error, or using a result before checking its error. Symptom: a program that
> "works" with wrong values (a service on a random port, an empty config, a truncated
> file) and no message anywhere. Fix: check every error where it is returned; discard one
> with `_` only when the function documents that it cannot fail in your case, and leave a
> comment saying why.

> [!NOTE]
> `go vet` does not report ignored errors in general. The `errcheck` linter (included in
> `golangci-lint`) does, and is worth enabling in CI.

linkcheck reads its configuration this way, returning errors instead of exiting, in
[[step-5-filters]].
