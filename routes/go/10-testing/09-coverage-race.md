---
title: Coverage and the race detector
done_when: "`go tool cover -func` lists the functions your tests do not reach, and `go test -race ./...` is clean for the package you wrote concurrent code in."
---
Two flags of `go test` check the *quality* of your tests rather than the code: **coverage** tells you which lines no test executes, and the **race detector** tells you which concurrent accesses to shared memory are unsynchronised. Neither proves the code is right. Both find problems that a passing test hides.

## Coverage

`go test -cover` instruments the package so that every **statement** counts how often it ran, then reports the percentage that ran at least once. This module has the `urlnorm` package from the earlier stops of this part, `Normalize` (with the IPv6 fix from [[fuzzing]]) and `Host`, and the table test from [[table-tests]]:

```bash
go test -cover ./...
```

```text
ok  	example.com/cover/urlnorm	0.427s	coverage: 72.0% of statements
```

72 per cent. The percentage does not say *which* 28 per cent. Write the profile to a file and ask the cover tool, which is part of the Go distribution:

```bash
go test -coverprofile=cover.out ./urlnorm
go tool cover -func=cover.out
```

```text
ok  	example.com/cover/urlnorm	0.420s	coverage: 72.0% of statements
example.com/cover/urlnorm/host.go:7:		Host		0.0%
example.com/cover/urlnorm/urlnorm.go:17:	Normalize	90.0%
total:						(statements)	72.0%
```

`Host` has no test at all, and `Normalize` has a gap. The profile file holds one line per block of statements, with the number of times it ran. A count of `0` is the gap:

```text
mode: set
example.com/cover/urlnorm/host.go:8.2,9.9 2 0
example.com/cover/urlnorm/host.go:10.3,11.1 1 0
example.com/cover/urlnorm/host.go:12.2,13.13 2 0
example.com/cover/urlnorm/urlnorm.go:18.2,19.16 2 1
```

Read a line as `file:startLine.col,endLine.col  statements  count`. Filtering the zero counts (`grep ' 0$' cover.out`) gives the unreached blocks of `Normalize`: lines 20 to 21, the `return "", err` after `url.Parse` fails, and lines 28 to 29, the IPv6 branch. Two tests close them:

```go title="urlnorm/more_test.go"
package urlnorm

import (
	"net/url"
	"testing"
)

func TestNormalizeIPv6(t *testing.T) {
	got, err := Normalize("http://[::1]:8080/a")
	if err != nil || got != "http://[::1]:8080/a" {
		t.Errorf("Normalize = %q, %v; want the address kept with its brackets", got, err)
	}
}

func TestNormalizeInvalid(t *testing.T) {
	_, err := Normalize("http://a b/")
	if _, ok := err.(*url.Error); !ok {
		t.Errorf("err = %T (%v), want *url.Error", err, err)
	}
}

func TestHost(t *testing.T) {
	tests := map[string]string{
		"https://go.dev/doc/":   "go.dev",
		"http://localhost:8080": "localhost:8080",
		"no-scheme":             "",
	}
	for in, want := range tests {
		if got := Host(in); got != want {
			t.Errorf("Host(%q) = %q, want %q", in, got, want)
		}
	}
}
```

```bash
go test -coverprofile=cover.out ./urlnorm
go tool cover -func=cover.out
```

```text
ok  	example.com/cover/urlnorm	0.445s	coverage: 100.0% of statements
example.com/cover/urlnorm/host.go:7:		Host		100.0%
example.com/cover/urlnorm/urlnorm.go:17:	Normalize	100.0%
total:						(statements)	100.0%
```

For a visual view run `go tool cover -html=cover.out -o cover.html` and open the file: covered code is green, uncovered red, and you click through the files.

### How it works

**Cover modes.** The profile's first line is `mode: set`: a block either ran or did not. `-covermode=count` records how many times each ran, and `-covermode=atomic` does the same with atomic counters, which is correct when the tests run goroutines in parallel. With `-race`, the default mode becomes `atomic`.

**Coverage is per package by default.** `go test -cover` counts only the package under test, even if its tests execute code in other packages. `-coverpkg=./...` counts statements in all listed packages, so a test in one package can be credited for what it runs in another. That is how an integration test earns coverage for the code it drives:

```bash
go test -cover -coverpkg=./... ./...
```

**Filter by test.** The coverage of one test is the coverage of what it alone runs. `go test -run 'TestNormalize$' -coverprofile=c.out` left `Host` at 0.0 per cent and `Normalize` at 90.0 per cent, so you can see what one test, or one table, exercises.

**Programs, not only tests.** A binary built with `go build -cover` writes coverage data when it exits, into the directory named by the `GOCOVERDIR` environment variable. That measures an end-to-end run:

```bash
go build -cover -o norm ./cmd/norm
mkdir covdata
GOCOVERDIR=covdata ./norm 'HTTPS://GO.dev:443/x#y'
go tool covdata percent -i=covdata
```

```text
https://go.dev/x
	example.com/cover/cmd/norm		coverage: 60.0% of statements
	example.com/cover/urlnorm		coverage: 60.0% of statements
```

(The program here is a ten-line `main` that calls `urlnorm.Normalize` on its first argument.) `go tool covdata textfmt -i=covdata -o=prof.txt` converts the data to a profile that `go tool cover -func` and `-html` read.

### What coverage can and cannot tell you

A line that ran is not a line that was checked. This test gives `Host` 100 per cent and tests nothing:

```go
func TestHostRuns(t *testing.T) { Host("https://go.dev/") }
```

Coverage shows what you have **not** tested; it cannot show that what you ran is correct. So treat the number as a way to find forgotten branches (error returns above all, as here), not as a target to hit. A team that demands 100 per cent gets tests like the one above. Reasonable use: look at `-func` output for the functions that matter, and read the red lines in the HTML view before a release.

## The race detector

A **data race** happens when two goroutines access the same memory at the same time, and at least one of them writes, with nothing ordering the accesses ([[memory-model]]). The result is undefined: wrong values, corrupted maps, rare crashes. The race detector is a build mode, `-race`, that records every memory access and every synchronisation event, and reports a race when it sees two unordered accesses to one address.

Here is a visited set of the kind a crawler might share between workers, written without protection:

```go title="visited.go"
// Package visited remembers which URLs a crawl has already seen.
package visited

// Set is a set of URLs.
type Set struct {
	seen map[string]bool
	n    int
}

// New returns an empty Set.
func New() *Set { return &Set{seen: make(map[string]bool)} }

// Add records url and reports whether it was new.
func (s *Set) Add(url string) bool {
	if s.seen[url] {
		return false
	}
	s.seen[url] = true
	s.n++
	return true
}

// Len returns the number of distinct URLs added.
func (s *Set) Len() int { return s.n }
```

```go title="visited_test.go"
package visited

import (
	"fmt"
	"sync"
	"testing"
)

func TestSetConcurrent(t *testing.T) {
	s := New()
	var wg sync.WaitGroup
	for w := range 8 {
		wg.Go(func() {
			for i := range 100 {
				s.Add(fmt.Sprintf("https://go.dev/page/%d", (w*50+i)%200))
			}
		})
	}
	wg.Wait()

	if got := s.Len(); got != 200 {
		t.Errorf("Len() = %d, want 200", got)
	}
}
```

Eight goroutines add overlapping URLs. Run the test normally, three times:

```bash
go test -count=1 .
```

```text
ok  	example.com/race-demo	0.454s
ok  	example.com/race-demo	0.409s
fatal error: concurrent map writes

goroutine 22 [running]:
internal/runtime/maps.fatal({0x7ff7abe0e8f1?, 0x7ff7abcb983a?})
```

Two passes and one crash, on the same code. The Go runtime notices some concurrent map writes by itself and kills the program, but only when the collision happens to land. The counter `n` has a race too, and nothing at all reports that. Now run with the detector:

```bash
go test -race -count=1 .
```

```text
==================
WARNING: DATA RACE
Read at 0x00c0001807b0 by goroutine 10:
  runtime.mapaccess2_faststr()
      .../internal/runtime/maps/runtime_faststr.go:120 +0x0
  runtime.mapaccess1_faststr()
      .../internal/runtime/maps/runtime_faststr.go:115 +0x17

Previous write at 0x00c0001807b0 by goroutine 13:
  runtime.mapassign_faststr()
      .../internal/runtime/maps/runtime_faststr.go:261 +0x0
  example.com/race-demo.(*Set).Add()
      .../race/visited.go:18 +0x16c
  example.com/race-demo.TestSetConcurrent.func1()
      .../race/visited_test.go:15 +0x39

Goroutine 10 (running) created at:
  sync.(*WaitGroup).Go()
      .../sync/waitgroup.go:238 +0x72
  testing.tRunner()
      .../testing/testing.go:2193 +0x1ca
==================
==================
WARNING: DATA RACE
Read at 0x00c0001942d8 by goroutine 10:
  example.com/race-demo.(*Set).Add()
      .../race/visited.go:19 +0x193

Previous write at 0x00c0001942d8 by goroutine 13:
  example.com/race-demo.(*Set).Add()
      .../race/visited.go:19 +0x1ab
...
    testing.go:1865: race detected during execution of test
FAIL
FAIL	example.com/race-demo	0.854s
```

(Paths are shortened, and the output is cut to the first reports; the run printed six.) It fails every time, whether or not the unlucky interleaving happened, because it checks the *ordering* of accesses, not the outcome. Each report has the same parts:

- **The two accesses:** a `Read` or `Write` at an address, with the goroutine and a stack trace, and the "Previous" access it conflicts with. Here the first report is the map (`visited.go:18`, the `s.seen[url] = true` write against a read in `Add`), and the second is `s.n++` at line 19, which the runtime's own map check never looks at.
- **Where each goroutine was created,** so you can tell which `go` statement started it.

The fix is to order the accesses. A mutex is the right tool for a set shared by workers ([[mutexes]]):

```go title="visited.go"
// Package visited remembers which URLs a crawl has already seen.
package visited

import "sync"

// Set is a set of URLs.
type Set struct {
	mu   sync.Mutex // guards seen and n
	seen map[string]bool
	n    int
}

// New returns an empty Set.
func New() *Set { return &Set{seen: make(map[string]bool)} }

// Add records url and reports whether it was new.
func (s *Set) Add(url string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.seen[url] {
		return false
	}
	s.seen[url] = true
	s.n++
	return true
}

// Len returns the number of distinct URLs added.
func (s *Set) Len() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.n
}
```

```bash
go test -race -count=20 .
```

```text
ok  	example.com/race-demo	1.898s
```

Twenty runs with the detector are clean.

### Using the detector

| Fact | Detail |
|---|---|
| Enable it | `go test -race ./...`, or `go run -race`, `go build -race` |
| Needs | cgo and a C compiler (a Go toolchain on its own is not enough on Windows) |
| Cost | Roughly 2 to 20 times the run time and 5 to 10 times the memory. Not for production |
| Finds | Races that actually happened in this run. Code the test never reaches, or reaches without concurrency, is not checked |
| Result | Each race fails the test, with a `race detected during execution of test` line |

Because the detector only sees what runs, the test must really run the code concurrently, as `TestSetConcurrent` does with eight goroutines. A test that calls `Add` from one goroutine passes under `-race` and the bug stays. For the same reason, `-count=N` and running the whole suite under `-race` in CI find more than one run of one test.

> [!WARNING]
> The two mistakes: **not running `-race` at all,** and **silencing it.** Symptom of the first: intermittent failures that "go away on re-run", corrupted counts, a `fatal error: concurrent map writes` once a month in production. Fix: put `go test -race ./...` in CI and in your pre-commit habit, and treat every report as a bug, not a flaky test. The second mistake is wrapping the report away (a `time.Sleep` that "fixes" the ordering, a retry, an `//go:build !race` tag on the test). A sleep only moves the interleaving; it does not order anything. The fix is always a synchronisation primitive: a mutex, a channel, `sync/atomic` ([[once-atomic]]) or confining the data to one goroutine.

> [!NOTE]
> Combine both checks in one CI command: `go test -race -cover ./...`. The bubble of [[synctest]] makes timing deterministic but does not make unsynchronised access safe, so run those tests under `-race` as well.

linkcheck's tests run with `-race`; its fake `Fetcher` from [[test-doubles]] and the progress counters that the workers write and a test reads are exactly the shared state this stop is about, in [[step-6-tests]] and [[step-3-concurrent]].
