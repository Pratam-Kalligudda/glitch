---
title: testdata and golden files
done_when: "A test compares your report output with testdata/text.golden, `go test ./report -update` rewrites the file, and `git diff` shows exactly what changed."
---
Some output is too large or too fiddly to write as a string in the test: a rendered report, a formatted table, generated code, an HTML page. A **golden file** stores the expected output in a file. The test produces the output, compares it with the file, and fails if they differ. A flag, conventionally `-update`, rewrites the file from the current output, so changing the expected result is a one-command step whose effect you review as an ordinary diff.

Golden files live in a directory named `testdata`. The go tool ignores directories called `testdata` when it matches `./...` patterns and builds packages, so you can put anything in there, including files that would not compile.

## A report and its golden file

linkcheck prints its results as an aligned text table. This is a cut-down version of the reporter that you build in [[step-7-reporters]].

```text title="go.mod"
module example.com/golden

go 1.27
```

```go title="report/report.go"
// Package report renders link check results as a text table.
package report

import (
	"fmt"
	"io"
	"text/tabwriter"
)

// Result is one checked link.
type Result struct {
	URL    string
	Status int
	Err    string
}

// Text writes one aligned line per result, then a summary line.
func Text(w io.Writer, results []Result) error {
	tw := tabwriter.NewWriter(w, 0, 0, 2, ' ', 0)
	broken := 0
	for _, r := range results {
		state := "ok"
		detail := fmt.Sprint(r.Status)
		if r.Err != "" {
			state, detail = "error", r.Err
			broken++
		} else if r.Status >= 400 {
			state = "broken"
			broken++
		}
		fmt.Fprintf(tw, "%s\t%s\t%s\n", state, detail, r.URL)
	}
	if err := tw.Flush(); err != nil {
		return err
	}
	_, err := fmt.Fprintf(w, "%d checked, %d broken\n", len(results), broken)
	return err
}
```

```go title="report/report_test.go"
package report

import (
	"bytes"
	"flag"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

var update = flag.Bool("update", false, "rewrite the golden files in testdata")

// golden compares got with testdata/<name>.golden. With -update it writes
// the file instead, so you can review the change with git diff.
func golden(t *testing.T, name string, got []byte) {
	t.Helper()
	path := filepath.Join("testdata", name+".golden")
	if *update {
		if err := os.MkdirAll("testdata", 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, got, 0o644); err != nil {
			t.Fatal(err)
		}
		return
	}
	want, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read golden file: %v (create it with: go test . -update)", err)
	}
	if !bytes.Equal(got, want) {
		t.Errorf("output differs from %s\n%s", path, firstDiff(string(want), string(got)))
	}
}

// firstDiff describes the first line where want and got differ.
func firstDiff(want, got string) string {
	w, g := strings.Split(want, "\n"), strings.Split(got, "\n")
	for i := 0; i < max(len(w), len(g)); i++ {
		var wl, gl string
		if i < len(w) {
			wl = w[i]
		}
		if i < len(g) {
			gl = g[i]
		}
		if wl != gl {
			return "line " + strconv.Itoa(i+1) + "\n  want: " + wl + "\n  got:  " + gl
		}
	}
	return "no line differs"
}

func TestText(t *testing.T) {
	results := []Result{
		{URL: "https://go.dev/", Status: 200},
		{URL: "https://go.dev/missing", Status: 404},
		{URL: "https://example.invalid/", Err: "no such host"},
	}
	var buf bytes.Buffer
	if err := Text(&buf, results); err != nil {
		t.Fatal(err)
	}
	golden(t, "text", buf.Bytes())
}
```

The first run has no golden file, and the test says so:

```bash
go test ./report
```

```text
--- FAIL: TestText (0.00s)
    report_test.go:66: read golden file: open testdata\text.golden: The system cannot find the file specified. (create it with: go test . -update)
FAIL
FAIL	example.com/golden/report	0.302s
FAIL
```

(The path separator and the message after the colon come from Windows; on Linux and macOS it reads `open testdata/text.golden: no such file or directory`.) Create the file with the flag:

```bash
go test ./report -update
cat report/testdata/text.golden
go test ./report
```

```text
ok  	example.com/golden/report	0.336s
ok      200           https://go.dev/
broken  404           https://go.dev/missing
error   no such host  https://example.invalid/
3 checked, 2 broken
ok  	example.com/golden/report	0.335s
```

The first `ok` is the update run, the four lines are the golden file, and the last `ok` is a normal run that compares against it.

## How it works

**`-update` is your own flag.** `var update = flag.Bool("update", ...)` registers it with the `flag` package. The test binary parses its command line before running tests, so `go test` can pass `-update` through. The `golden` helper reads the flag: when it is set, the helper writes the file and returns; otherwise it reads the file and compares bytes.

**One helper, many golden files.** `golden(t, "text", got)` names the file `testdata/text.golden`. A second reporter test calls `golden(t, "json", ...)` and gets its own file. Keep the helper in a `_test.go` file and give it `t.Helper()` ([[test-helpers]]) so a mismatch is reported at the test's line.

**The mismatch message points at the line.** Comparing two long strings with `%q` is unreadable. `firstDiff` prints the first line that differs. Suppose the word `broken` is renamed `dead`, which narrows the status column:

```text
--- FAIL: TestText (0.00s)
    report_test.go:66: output differs from testdata\text.golden
        line 1
          want: ok      200           https://go.dev/
          got:  ok     200           https://go.dev/
FAIL
FAIL	example.com/golden/report	0.303s
FAIL
```

That is enough to see a missing space. Only the first differing line is shown; to see every difference, run the test with `-update` and read `git diff`, as below.

**Where the flag goes matters.** The package path must come *before* `-update`:

```bash
go test -update ./report
```

```text
no Go files in C:\...\golden
FAIL	. [setup failed]
```

`go test` does not know `-update`, so it treats everything from there on as arguments for the test binary and finds no package list: it falls back to the current directory, which has no Go files. Write `go test ./report -update`, or `go test ./report -args -update` to be explicit. The flag exists only in packages that declare it. Run over many packages, the others fail:

```bash
go test ./... -update
```

```text
flag provided but not defined: -update
Usage of C:\...\other.test.exe:
...
FAIL	example.com/golden/other	0.330s
ok  	example.com/golden/report
FAIL
```

So run `-update` for the package you mean to change, or declare the flag in every package that has golden files.

## Reviewing a change

Say you reword the summary line, from `checked` to `links`. The test fails, naming the line:

```text
--- FAIL: TestText (0.00s)
    report_test.go:66: output differs from testdata\text.golden
        line 4
          want: 3 checked, 2 broken
          got:  3 links, 2 broken
FAIL
FAIL	example.com/golden/report	0.316s
FAIL
```

The change is intentional, so accept it: `go test ./report -update`, then run the tests again (they pass, and the last line of `text.golden` is now `3 links, 2 broken`). Commit the golden file with the code. In review, `git diff testdata/` shows precisely how the output changed, and that diff is the real assertion: a reviewer reads it and decides whether the new output is right.

## Rules that keep golden tests honest

- **Make the output deterministic.** A report with a timestamp, a random ID, a map printed in iteration order or an absolute path fails on the next run. Sort before writing, pass a fixed clock into the code, and keep paths relative. If a volatile part is unavoidable, replace it in the test before comparing (for instance `strings.ReplaceAll(got, tmpDir, "<tmp>")`).
- **Keep one golden file per case,** named after it. For a table of cases, build the name from the subtest: `strings.ReplaceAll(t.Name(), "/", "_")`, so `TestText/empty` becomes `TestText_empty`. Do not use `t.Name()` raw: a slash in it becomes a directory.
- **Stop Git rewriting line endings.** On Windows, `core.autocrlf` can turn the `\n` in a golden file into `\r\n` on checkout, and then every comparison fails on a machine where the output is correct. Add `testdata/** -text` to `.gitattributes`, so Git stores and checks the files out byte for byte.
- **Compare bytes, not trimmed text,** unless trailing whitespace truly does not matter. A report that gained a trailing space is a changed report.
- **Keep inputs in `testdata` too.** Real inputs such as an HTML page to parse belong next to the golden output, as `testdata/page.html` and `testdata/page.golden`. Tests run with the package directory as the working directory, so `os.ReadFile("testdata/page.html")` works with a relative path.

The go tool also leaves `testdata` out of package lists, so even a Go file in it is not built. With a stray `testdata/extra/x.go` in place, `go list ./...` still prints only `example.com/golden/report`.

> [!WARNING]
> `-update` accepts whatever the code prints now, bugs included. Symptom: a test that always passes because the golden file was regenerated after every change, so it no longer guards anything. Fix: never run `-update` and commit without reading `git diff` of the golden files; run it only for a package you meant to change; and in CI run tests without `-update` so a stale golden file fails the build. A golden file is also a poor fit when only one value matters. Assert that value directly, and keep golden files for output whose whole shape matters.

> [!NOTE]
> For output that is a Go value, such as a struct or a nested map, compare the values (`slices.Equal`, `maps.Equal`, `reflect.DeepEqual`) instead of serialising them to a golden file. A golden file is for text that people read.

linkcheck's five reporters, text, JSON, CSV, JUnit XML and HTML, each get a golden file in [[step-7-reporters]].
