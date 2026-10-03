---
title: Test helpers and cleanup
done_when: "A failing helper reports the line of the test that called it, your temporary files vanish by themselves, and no test calls os.Setenv, os.Chdir or os.RemoveAll directly."
---
Tests repeat setup: write a file, set an environment variable, start something that must be stopped. Pulled into a function, that setup is a **test helper**. Two problems come with helpers. A failure inside one is reported at the helper's line, not the test's, and anything the helper creates must be removed even when the test fails halfway. The `testing` package answers both: `t.Helper()` and `t.Cleanup()`, plus a set of methods that create and undo common state for you.

## A helper that cleans up after itself

linkcheck reads a settings file, so its tests need real files. This package is small on purpose: the interesting part is the test file.

```text title="go.mod"
module example.com/helpers

go 1.27
```

```go title="config.go"
// Package config reads a linkcheck-style settings file.
package config

import (
	"bufio"
	"fmt"
	"os"
	"strings"
)

// Load reads key=value lines from path. Lines starting with # are comments.
func Load(path string) (map[string]string, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()

	cfg := make(map[string]string)
	sc := bufio.NewScanner(f)
	for n := 1; sc.Scan(); n++ {
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		k, v, ok := strings.Cut(line, "=")
		if !ok {
			return nil, fmt.Errorf("%s:%d: missing =", path, n)
		}
		cfg[strings.TrimSpace(k)] = strings.TrimSpace(v)
	}
	return cfg, sc.Err()
}

// Env returns the value of LINKCHECK_<key>, or fallback.
func Env(key, fallback string) string {
	if v, ok := os.LookupEnv("LINKCHECK_" + key); ok {
		return v
	}
	return fallback
}
```

```go title="config_test.go"
package config

import (
	"os"
	"path/filepath"
	"testing"
)

// writeConfig writes body to a new file in a per-test temporary directory
// and returns its path.
func writeConfig(t *testing.T, body string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "linkcheck.conf")
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatalf("write config: %v", err)
	}
	return path
}

func TestLoad(t *testing.T) {
	path := writeConfig(t, "# crawl settings\ndepth = 3\nhost = go.dev\n")
	cfg, err := Load(path)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg["depth"] != "3" || cfg["host"] != "go.dev" {
		t.Errorf("Load = %v, want depth=3 host=go.dev", cfg)
	}
}

func TestLoadBadLine(t *testing.T) {
	path := writeConfig(t, "depth 3\n")
	if _, err := Load(path); err == nil {
		t.Fatal("Load succeeded, want an error for the line without =")
	}
}

func TestEnv(t *testing.T) {
	t.Setenv("LINKCHECK_DEPTH", "7")
	if got := Env("DEPTH", "2"); got != "7" {
		t.Errorf("Env(DEPTH) = %q, want 7", got)
	}
	if got := Env("MISSING", "2"); got != "2" {
		t.Errorf("Env(MISSING) = %q, want the fallback 2", got)
	}
}
```

```bash
go test -v .
```

```text
=== RUN   TestLoad
--- PASS: TestLoad (0.13s)
=== RUN   TestLoadBadLine
--- PASS: TestLoadBadLine (0.06s)
=== RUN   TestEnv
--- PASS: TestEnv (0.00s)
PASS
ok  	example.com/helpers	0.853s
```

Nothing in the test deletes the files it wrote. `t.TempDir()` returns a new empty directory unique to this test (and to each subtest) and removes it, with its contents, when the test and its subtests finish. Two tests never see each other's files, so they can run in parallel. The directory is created under `os.TempDir()`, or under `GOTMPDIR` if you set it.

## t.Helper: report the caller's line

A helper that calls `t.Errorf` reports its own file and line by default. The line tells you nothing: every caller of `assertEqual` fails at the same place. `t.Helper()` marks the calling function as a helper, and `go test` then skips it when it picks the line to print.

```go title="h1/h_test.go"
package h1

import "testing"

func assertEqual(t *testing.T, got, want int) {
	if got != want {
		t.Errorf("got %d, want %d", got, want)
	}
}

func TestSum(t *testing.T) {
	assertEqual(t, 1+1, 3)
}
```

```text
--- FAIL: TestSum (0.00s)
    h_test.go:7: got 2, want 3
```

Line 7 is the `t.Errorf` inside the helper. Add `t.Helper()` as the first statement of `assertEqual` (the file moves the `if` to line 7 and the call to line 13) and the same failure points at the test:

```text
--- FAIL: TestSum (0.00s)
    h_test.go:13: got 2, want 3
```

Line 13 is `assertEqual(t, 1+1, 3)`, the line you must go and read. A helper can call another helper; each one that calls `t.Helper()` is skipped, so the report names the first line outside all of them.

Rules for helpers:

- Take `t *testing.T` (or `testing.TB`, the interface that `*testing.T` and `*testing.B` both implement, if benchmarks use the helper too) as the **first** parameter, as `context.Context` does.
- Call `t.Helper()` first. It is cheap, and it is safe from several goroutines.
- Fail inside the helper with `t.Fatalf`, so the test body stays free of `if err != nil` for setup that cannot fail in a correct world. Return the value, not the error.
- Do not hide the assertion you are testing in a helper. `writeConfig` is setup, so a helper fits. `if cfg["depth"] != "3"` is the claim of the test, so it stays visible in the test body.

## t.Cleanup: undo in reverse order

`t.Cleanup(f)` registers `f` to run when the test finishes, whether it passed, failed, called `t.Fatal` or `t.FailNow`, or was skipped. Cleanups run in **last added, first called** order, like `defer`, so the thing created last is undone first. They also run after the test's subtests are done.

```go title="life/life_test.go"
package life

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestOrder(t *testing.T) {
	t.Cleanup(func() { fmt.Println("cleanup 1 (registered first)") })
	t.Cleanup(func() { fmt.Println("cleanup 2 (registered last)") })
	fmt.Println("test body")
}

func TestContext(t *testing.T) {
	ctx := t.Context()
	done := make(chan struct{})
	go func() {
		<-ctx.Done()
		close(done)
	}()
	t.Cleanup(func() {
		select {
		case <-done:
			fmt.Println("worker saw ctx cancelled before cleanup ran:", ctx.Err())
		case <-time.After(time.Second):
			fmt.Println("worker did not stop")
		}
	})
}

func TestChdir(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "seed.txt"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Chdir(dir)
	if _, err := os.Stat("seed.txt"); err != nil {
		t.Fatalf("relative open failed: %v", err)
	}
}

func TestArtifact(t *testing.T) {
	dir := t.ArtifactDir()
	t.Log("artifact dir:", dir)
	if err := os.WriteFile(filepath.Join(dir, "report.txt"), []byte("hello\n"), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestSkip(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping slow test in -short mode")
	}
}
```

```bash
go test -v .
```

```text
=== RUN   TestOrder
test body
cleanup 2 (registered last)
cleanup 1 (registered first)
--- PASS: TestOrder (0.00s)
=== RUN   TestContext
worker saw ctx cancelled before cleanup ran: context canceled
--- PASS: TestContext (0.00s)
=== RUN   TestChdir
--- PASS: TestChdir (0.00s)
=== RUN   TestArtifact
    life_test.go:47: artifact dir: C:\Users\Pratam\AppData\Local\Temp\TestArtifact1199953633\001
--- PASS: TestArtifact (0.03s)
=== RUN   TestSkip
--- PASS: TestSkip (0.00s)
PASS
ok  	example.com/helpers/life	0.402s
```

(The module has these in a `life` package, run with `go test -v ./life`. Paths in the output are from a Windows machine and a temporary directory, and the number in `TestArtifact1199953633` changes every run.)

Why use `t.Cleanup` instead of `defer` in a helper? A `defer` inside `startServer(t)` runs when the helper returns, which is before the test has used the server. `t.Cleanup` runs at the end of the *test*, so a helper can create a resource and arrange its removal in one place and the caller never has to remember. This is the pattern for every helper that starts something: create it, register `t.Cleanup(stop)`, return it.

## The built-in state helpers

| Method | Does | Since |
|---|---|---|
| `t.TempDir()` | A new empty directory, removed after the test | 1.15 |
| `t.Setenv(k, v)` | `os.Setenv`, restored after the test | 1.17 |
| `t.Chdir(dir)` | `os.Chdir`, restored after the test | 1.24 |
| `t.Context()` | A context cancelled just before cleanups run | 1.24 |
| `t.ArtifactDir()` | A directory for output files you may want to keep | 1.26 |
| `t.Skip(...)`, `t.Skipf(...)` | Stop and mark the test skipped | |
| `testing.Short()` | True when `go test -short` was used | |

**`t.Context()` (Go 1.24).** A test that starts a goroutine must stop it, or the goroutine outlives the test and may touch state of the next one. `t.Context()` gives you a context that is cancelled right *before* the cleanups run. Pass it to the worker, and a cleanup can then wait for the worker to finish, as `TestContext` does. Before 1.24 each test made its own `context.WithCancel` and `defer cancel()`. See [[context]] for how cancellation reaches a goroutine.

**`t.Chdir` (Go 1.24).** Code that opens relative paths such as `testdata/seed.txt` depends on the working directory. `t.Chdir(dir)` changes into `dir` and puts the old directory back afterwards.

**`t.ArtifactDir()` (Go 1.26).** Some tests produce output that you want to look at after a failure: a rendered report, a screenshot, a diff. `t.ArtifactDir()` returns a directory for those files. Without the `-artifacts` flag it is a temporary directory removed after the test, so the file is only checked, never kept. With the flag, the directory is kept under the output directory:

```bash
go test -v -run Artifact -artifacts ./life
```

```text
=== RUN   TestArtifact
=== ARTIFACTS TestArtifact C:\...\helpers\_artifacts\life\TestArtifact\2297960004
    life_test.go:47: artifact dir: C:\...\helpers\_artifacts\life\TestArtifact\2297960004
--- PASS: TestArtifact (0.01s)
PASS
ok  	example.com/helpers/life	0.321s
```

The `=== ARTIFACTS` line names the directory, and `report.txt` is there afterwards, in `_artifacts/<package>/<test>/<random>`. Each test gets its own directory; a subtest's directory is not nested under its parent's. CI systems can upload the whole `_artifacts` tree when a run fails.

**`t.Skip`.** Skipping reports `--- SKIP` with your message and counts as neither a pass nor a failure. Use it for a test that needs something the machine lacks, such as network access or a tool. `testing.Short()` lets slow tests opt out of `go test -short`:

```text
=== RUN   TestSkip
    life_test.go:55: skipping slow test in -short mode
--- SKIP: TestSkip (0.00s)
PASS
ok  	example.com/helpers/life	0.293s
```

## TestMain: setup for the whole package

When one setup serves every test in a package, such as starting a database once, define `TestMain(m *testing.M)` in any `_test.go` file. `go test` then runs it *instead of* the tests; you call `m.Run()` to run them, and pass its result to `os.Exit`.

```go title="tm/tm_test.go"
package tm

import (
	"fmt"
	"os"
	"testing"
)

func TestMain(m *testing.M) {
	fmt.Println("setup: once per package")
	code := m.Run()
	fmt.Println("teardown: once per package")
	os.Exit(code)
}

func TestA(t *testing.T) {}
func TestB(t *testing.T) {}
```

```text
setup: once per package
=== RUN   TestA
--- PASS: TestA (0.00s)
=== RUN   TestB
--- PASS: TestB (0.00s)
PASS
teardown: once per package
ok  	example.com/helpers/tm	0.316s
```

Reach for `TestMain` last. Its state is global, it cannot see a `*testing.T`, and `os.Exit` skips deferred calls, so teardown must run before it. A helper with `t.Cleanup` almost always does the job with less hidden coupling.

> [!WARNING]
> `t.Setenv` and `t.Chdir` change process-wide state, so they refuse to run in a parallel test. Symptom: a panic, not a failure:
>
> ```text
> panic: testing: test using t.Setenv, t.Chdir, or cryptotest.SetGlobalRandom can not use t.Parallel
> ```
>
> Fix: remove `t.Parallel()` from that test, or stop depending on the environment or working directory (pass the value in as an argument). Reaching for `os.Setenv` instead is worse: it works in parallel tests, then leaks into other tests, so they pass or fail depending on order. The same goes for hand-made directories with `os.MkdirTemp` plus a forgotten `os.RemoveAll`: use `t.TempDir()`.

> [!NOTE]
> Cleanups do not run if the test binary dies, for example on `os.Exit` or an unrecovered panic in another goroutine. Keep cleanups short and make them tolerate a half-built resource: the test may have failed before it finished creating it.

linkcheck's step 6 tests build their fixtures with helpers like these, in [[step-6-tests]]. Faking a collaborator takes a different tool, covered next in [[test-doubles]].
