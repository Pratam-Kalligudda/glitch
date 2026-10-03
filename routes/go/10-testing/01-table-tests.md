---
title: Table-driven tests and subtests
done_when: "`go test -v -run 'TestNormalize/default'` runs only the matching subtests, and every case of your table is a named row, not a copied block of code."
---
A Go test is an ordinary function in a file ending in `_test.go`, named `TestXxx` and taking a `*testing.T`. There is no assertion library: you call the function under test, compare, and report with `t.Errorf`. Most functions need many inputs, and copying the same five lines per input hides what differs between them. The idiom is a **table-driven test**: a slice of structs, one per case, and one loop that runs them all. Adding a case is adding a row.

Each row also becomes a **subtest**, a named test started with `t.Run`. Subtests are reported on their own, can be selected from the command line and can run in parallel.

## A table for a URL normaliser

linkcheck must treat `https://GO.dev/doc/#install` and `https://go.dev/doc/` as the same page, or it will fetch it twice. That is the job of a small package that you test here and use in [[step-6-tests]].

```text title="go.mod"
module example.com/table-tests

go 1.27
```

```go title="urlnorm/urlnorm.go"
// Package urlnorm turns URLs into one canonical form, so that two
// spellings of the same page compare equal.
package urlnorm

import (
	"errors"
	"fmt"
	"net/url"
	"strings"
)

// ErrScheme reports a URL whose scheme is not http or https.
var ErrScheme = errors.New("unsupported scheme")

// Normalize lowercases the scheme and host, drops the default port and
// the fragment, and turns an empty path into "/".
func Normalize(raw string) (string, error) {
	u, err := url.Parse(raw)
	if err != nil {
		return "", err
	}
	u.Scheme = strings.ToLower(u.Scheme)
	if u.Scheme != "http" && u.Scheme != "https" {
		return "", fmt.Errorf("%q: %w", raw, ErrScheme)
	}
	host := strings.ToLower(u.Hostname())
	port := u.Port()
	if (u.Scheme == "http" && port == "80") || (u.Scheme == "https" && port == "443") {
		port = ""
	}
	if port != "" {
		host += ":" + port
	}
	u.Host = host
	u.Fragment = ""
	u.RawFragment = ""
	if u.Path == "" {
		u.Path = "/"
	}
	return u.String(), nil
}
```

```go title="urlnorm/urlnorm_test.go"
package urlnorm

import (
	"errors"
	"testing"
)

func TestNormalize(t *testing.T) {
	tests := []struct {
		name    string
		in      string
		want    string
		wantErr error
	}{
		{name: "already clean", in: "https://go.dev/doc/", want: "https://go.dev/doc/"},
		{name: "upper-case host", in: "https://GO.dev/doc/", want: "https://go.dev/doc/"},
		{name: "upper-case scheme", in: "HTTPS://go.dev/", want: "https://go.dev/"},
		{name: "default http port", in: "http://example.com:80/a", want: "http://example.com/a"},
		{name: "default https port", in: "https://example.com:443/a", want: "https://example.com/a"},
		{name: "other port kept", in: "http://example.com:8080/a", want: "http://example.com:8080/a"},
		{name: "fragment dropped", in: "https://go.dev/doc/#install", want: "https://go.dev/doc/"},
		{name: "empty path", in: "https://go.dev", want: "https://go.dev/"},
		{name: "query kept", in: "https://go.dev/s?q=go", want: "https://go.dev/s?q=go"},
		{name: "mailto rejected", in: "mailto:gopher@go.dev", wantErr: ErrScheme},
		{name: "relative rejected", in: "/doc/", wantErr: ErrScheme},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got, err := Normalize(tc.in)
			if !errors.Is(err, tc.wantErr) {
				t.Fatalf("Normalize(%q) error = %v, want %v", tc.in, err, tc.wantErr)
			}
			if got != tc.want {
				t.Errorf("Normalize(%q) = %q, want %q", tc.in, got, tc.want)
			}
		})
	}
}
```

```bash
go test -v ./urlnorm
```

```text
=== RUN   TestNormalize
=== RUN   TestNormalize/already_clean
=== RUN   TestNormalize/upper-case_host
=== RUN   TestNormalize/upper-case_scheme
=== RUN   TestNormalize/default_http_port
=== RUN   TestNormalize/default_https_port
=== RUN   TestNormalize/other_port_kept
=== RUN   TestNormalize/fragment_dropped
=== RUN   TestNormalize/empty_path
=== RUN   TestNormalize/query_kept
=== RUN   TestNormalize/mailto_rejected
=== RUN   TestNormalize/relative_rejected
--- PASS: TestNormalize (0.00s)
    --- PASS: TestNormalize/already_clean (0.00s)
    --- PASS: TestNormalize/upper-case_host (0.00s)
    --- PASS: TestNormalize/upper-case_scheme (0.00s)
    --- PASS: TestNormalize/default_http_port (0.00s)
    --- PASS: TestNormalize/default_https_port (0.00s)
    --- PASS: TestNormalize/other_port_kept (0.00s)
    --- PASS: TestNormalize/fragment_dropped (0.00s)
    --- PASS: TestNormalize/empty_path (0.00s)
    --- PASS: TestNormalize/query_kept (0.00s)
    --- PASS: TestNormalize/mailto_rejected (0.00s)
    --- PASS: TestNormalize/relative_rejected (0.00s)
PASS
ok  	example.com/table-tests/urlnorm	0.343s
```

Without `-v`, a passing package prints only the last line. The time varies.

## How it works

**The go tool finds tests by name.** `go test` compiles every `_test.go` file in the package together with the package itself, and runs each function named `Test` followed by an uppercase letter (or a non-letter). A `_test.go` file is never part of a normal build, so test code costs nothing in the program you ship. Because the file declares `package urlnorm`, the test can also call unexported functions. Use `package urlnorm_test` in a separate file to test only what an importer can see; both can live in one directory.

**The table is a slice of an anonymous struct.** The fields are the inputs (`in`), the expected outputs (`want`, `wantErr`) and a `name`. Naming the fields in each row keeps the table readable and lets you leave out zero values, as the `mailto rejected` row does.

**`t.Run(name, func(t *testing.T))` starts a subtest.** It runs the function with its own `*testing.T`, waits for it, and reports it as `TestNormalize/<name>`. The name is rewritten for the command line: spaces become underscores, so `default http port` is `default_http_port`. A failure in one subtest does not stop the others, which is the point: one run shows every broken case.

**Select subtests with `-run`.** The pattern is split on `/`, and each part is a regular expression matched against that level of the name, unanchored:

```bash
go test -v -run 'TestNormalize/default' ./urlnorm
```

```text
=== RUN   TestNormalize
=== RUN   TestNormalize/default_http_port
=== RUN   TestNormalize/default_https_port
--- PASS: TestNormalize (0.00s)
    --- PASS: TestNormalize/default_http_port (0.00s)
    --- PASS: TestNormalize/default_https_port (0.00s)
PASS
ok  	example.com/table-tests/urlnorm	0.343s
```

Anchor with `^` and `$` when one name is a prefix of another: `-run '^TestNormalize$/^empty_path$'` runs exactly one subtest.

**`Errorf` against `Fatalf`.** Both print the message and mark the test failed. `t.Errorf` lets the test carry on; `t.Fatalf` stops the current test (the subtest, here) at once. Stop when the next line cannot make sense, as after an unexpected error, and carry on when the next check is independent. In the table, a wrong error is `Fatalf` because `got` is then meaningless, and the value comparison is `Errorf`. Call `t.Fatal` only from the goroutine that runs the test: it stops that goroutine, not another one.

**A failure names the case and the input.** Break one row (`want: "https://go.dev/doc"`) to see what you get:

```text
--- FAIL: TestNormalize (0.00s)
    --- FAIL: TestNormalize/fragment_dropped (0.00s)
        urlnorm_test.go:34: Normalize("https://go.dev/doc/#install") = "https://go.dev/doc/", want "https://go.dev/doc"
FAIL
FAIL	example.com/table-tests/urlnorm	0.349s
FAIL
```

The convention for the message is `Function(input) = got, want expected`. Print the input so the failure is understandable without opening the file, and print values with `%q` or `%v` so invisible differences, such as a trailing space, show up.

**Compare errors with `errors.Is`, not by text.** The row holds the sentinel `ErrScheme`, and the loop asks `errors.Is(err, tc.wantErr)`. When `wantErr` is nil, `errors.Is(nil, nil)` is true and any real error makes it false, so one check covers both "no error expected" and "this error expected" ([[is-as]]). Matching on `err.Error()` breaks the first time someone rewords a message.

## Subtests in parallel

Calling `t.Parallel()` at the start of a subtest pauses it until the parent function returns, then runs all paused siblings together, up to `GOMAXPROCS` at a time (`-parallel n` changes that limit). It pays off for slow, independent cases, such as ones that wait on I/O:

```go title="par/par_test.go"
package par

import (
	"testing"
	"time"
)

func TestParallel(t *testing.T) {
	for _, d := range []int{1, 2, 3, 4} {
		t.Run("case", func(t *testing.T) {
			t.Parallel()
			time.Sleep(200 * time.Millisecond)
			t.Log("d =", d)
		})
	}
}
```

```bash
go test -v ./par
```

```text
=== PAUSE TestParallel/case
=== PAUSE TestParallel/case#01
=== PAUSE TestParallel/case#02
=== PAUSE TestParallel/case#03
=== CONT  TestParallel/case
=== CONT  TestParallel/case#03
=== CONT  TestParallel/case#02
=== CONT  TestParallel/case#01
    par_test.go:13: d = 2
=== NAME  TestParallel/case#02
    par_test.go:13: d = 3
=== NAME  TestParallel/case
    par_test.go:13: d = 1
=== NAME  TestParallel/case#03
    par_test.go:13: d = 4
--- PASS: TestParallel (0.00s)
    --- PASS: TestParallel/case#01 (0.20s)
    --- PASS: TestParallel/case#02 (0.20s)
    --- PASS: TestParallel/case (0.20s)
    --- PASS: TestParallel/case#03 (0.20s)
PASS
ok  	example.com/table-tests/par	0.549s
```

The `=== RUN` lines are left out, and the order of the rest varies. The four 200 ms sleeps overlapped. With `-parallel 1` the same package takes 1.1 s.

Two things in this output matter:

- **Duplicate names get a suffix.** All four subtests are called `case`, so the second is `case#01`, then `case#02`. A repeated name is legal but unhelpful, because you can no longer tell which row failed. Give every row a unique name.
- **No loop-variable copy.** Each parallel subtest ran after the loop had finished, and `d` is still 1, 2, 3 and 4. Since Go 1.22 every iteration has its own variable ([[loop-variables]]). Old code that writes `tc := tc` before `t.Run` is a leftover; delete it.

> [!WARNING]
> Parallel subtests share whatever the table shares. Reading a `want` value is safe, but a parallel case that writes a shared map, global or file is a data race that fails only sometimes. Symptom: a test that passes alone and fails in the full run, or fails under `-race` ([[coverage-race]]). Fix: give each subtest its own fixtures (`t.TempDir` in [[test-helpers]]), or drop `t.Parallel` for that table. Parallelism is also no gain for fast, CPU-light cases like `Normalize`: starting goroutines costs more than the work.

## Choosing the shape of a table

| Choice | When |
|---|---|
| Slice of structs | The default. Order is stable and the failing row is easy to find |
| `map[string]struct{...}` keyed by name | You want unique names enforced by the compiler. Iteration order is random, so cases run in a different order each time |
| Struct with a `func(t *testing.T)` field | Rows need different setup. If every row has its own body, write separate tests instead |
| One `Test` per behaviour | A case needs its own explanation, not just different data |

Keep the loop body small and free of branches on the case. A loop full of `if tc.name == ...` is several tests squeezed into one; split them. A `name` that says what the row demonstrates (`fragment dropped`) is worth more than `case 7`.

linkcheck's `Normalize` and its link filters get tables exactly like this one in [[step-6-tests]].
