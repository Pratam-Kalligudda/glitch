---
title: Data races and the memory model
done_when: "`go run -race ./race` prints a DATA RACE report and exits with status 66, and the fixed program runs clean under `-race`."
---
The Go memory model is the rule that says when a write in one goroutine is guaranteed to
be visible to a read in another. Without such a rule, compilers and CPUs are free to
reorder and cache memory operations, and a goroutine may never see another's writes. The
rule has a short practical form, quoted from the model itself: "If you must read the rest
of this document to understand the behavior of your program, you are being too clever.
Don't be clever." Synchronise with channels, `sync` or `sync/atomic`, and the guarantees
below do the rest.

A **data race** is a write to a memory location happening concurrently with another read
or write to that same location, unless all the accesses are atomic (`sync/atomic`).
"Concurrently" means neither access is ordered before the other by synchronisation.

## Finding a race: the race detector

```go title="race/main.go"
package main

import (
	"fmt"
	"sync"
)

func main() {
	checked := 0
	var wg sync.WaitGroup
	for range 2 {
		wg.Go(func() {
			checked++ // written by two goroutines with no synchronisation
		})
	}
	wg.Wait()
	fmt.Println("checked:", checked)
}
```

```bash
go run -race ./race
```

```text
==================
WARNING: DATA RACE
Read at 0x00c000096068 by goroutine 9:
  main.main.func1()
      .../memory-model/race/main.go:13 +0x2e

Previous write at 0x00c000096068 by goroutine 8:
  main.main.func1()
      .../memory-model/race/main.go:13 +0x44

Goroutine 9 (running) created at:
  sync.(*WaitGroup).Go()
      GOROOT/src/sync/waitgroup.go:238 +0x72

Goroutine 8 (finished) created at:
  sync.(*WaitGroup).Go()
      GOROOT/src/sync/waitgroup.go:238 +0x72
==================
checked: 2
Found 1 data race(s)
exit status 66
```

Paths are shortened; addresses and goroutine numbers change between runs. Without
`-race` the same program prints `checked: 2` and exits 0. The bug is invisible until two
increments happen to overlap; in [[mutexes]] that lost 1,649 of 100,000 increments.

### Reading the report

1. **The two accesses.** `Read at ... by goroutine 9` and `Previous write at ... by
   goroutine 8`, each with a stack. Both point at line 13, `checked++`, which is a read
   followed by a write.
2. **Where each goroutine was created.** Here both came from `wg.Go`. With a plain `go`
   statement the stack shows the line in your code instead.
3. **The summary.** `Found 1 data race(s)` and exit status 66, so CI fails.

### How the detector works

`-race` compiles your program with instrumentation on every memory access and links a
runtime library (ThreadSanitizer) that tracks, for each memory word, which goroutine last
touched it and at what point in that goroutine's history. Every synchronising operation
(channel send and receive, mutex lock and unlock, `WaitGroup`, atomics) records an
ordering edge. When an access is not ordered after the previous conflicting access by
some chain of edges, that is a race and the detector reports it.

Facts from the race detector documentation:

| Fact | Detail |
|---|---|
| Commands | `go run -race`, `go build -race`, `go test -race`, `go install -race` |
| Requirements | cgo enabled and a C compiler (on Windows, gcc from mingw-w64 version 8 or later). Supported on linux, darwin and windows on amd64 and arm64, and a few other ports |
| Cost | Memory use may grow 5-10x and execution time 2-20x |
| Exit status | 66 when a race was found (set another with `GORACE="exitcode=1"`) |
| Stop at the first race | `GORACE="halt_on_error=1"` |
| Blind spot | It only finds races in code that actually runs. A path your tests never execute is never checked |

The Go blog's introduction to the detector puts it plainly: "It will not issue false
positives, so take its warnings seriously." A clean run is not proof there is none,
only that none happened in the paths you exercised.

## The happens-before rules

Go defines "happens before" (the model says "synchronized before") through these
operations. If an event A happens before B, B is guaranteed to see A's writes.

| Operation | Guarantee |
|---|---|
| `go f()` | The `go` statement happens before `f` starts. `f` sees everything written before it was started |
| Goroutine exit | **No** guarantee on its own. You need a channel, `WaitGroup` or lock to observe a goroutine's writes |
| Channel send | A send happens before the corresponding receive completes |
| `close(ch)` | Happens before a receive that returns because the channel is closed |
| Unbuffered receive | Happens before the corresponding send completes |
| Buffered capacity C | The k-th receive happens before the (k+C)-th send completes. This is why a buffered channel works as a semaphore ([[worker-pools]]) |
| `Mutex` | The n-th `Unlock` happens before the (n+1)-th `Lock` returns |
| `Once` | The completion of `f` in `once.Do(f)` happens before any `Do` returns |
| `WaitGroup` | Each task's `Done` (or the return of `f` in `wg.Go(f)`) happens before the `Wait` it unblocks returns |
| Atomics | If an atomic operation B observes the effect of atomic operation A, A happens before B |

Happens-before is transitive. In the fixed program below, the write to `report` comes
before `close(done)` in the same goroutine, the close happens before the receive in
`main`, and the receive comes before the read: so the read sees the write.

## What a race looks like when it is not a counter

The common real-world form is a "done" flag:

```go title="busy/main.go"
package main

import (
	"fmt"
	"time"
)

var (
	report string
	done   bool
)

func crawl() {
	time.Sleep(10 * time.Millisecond)
	report = "3 broken links"
	done = true
}

func main() {
	go crawl()
	for !done { // busy-wait on a plain bool: a data race
	}
	fmt.Println(report)
}
```

On the machine used for this route, `go run ./busy` happened to print `3 broken links`.
Nothing guarantees it. The memory model says that observing `done == true` does not
imply observing the write to `report`, and that the loop may never end: the compiler is
allowed to read `done` once and keep it in a register, and on CPUs with weaker ordering
than x86 the two writes can become visible in the other order. `-race` reports both
problems:

```bash
go run -race ./busy
```

```text
==================
WARNING: DATA RACE
Write at 0x0001402659c8 by goroutine 8:
  main.crawl()
      .../memory-model/busy/main.go:16 +0x6d

Previous read at 0x0001402659c8 by main goroutine:
  main.main()
      .../memory-model/busy/main.go:21 +0x33

Goroutine 8 (running) created at:
  main.main()
      .../memory-model/busy/main.go:20 +0x27
==================
==================
WARNING: DATA RACE
Read at 0x0001402202d0 by main goroutine:
  main.main()
      .../memory-model/busy/main.go:23 +0x4e

Previous write at 0x0001402202d0 by goroutine 8:
  main.crawl()
      .../memory-model/busy/main.go:15 +0x30

Goroutine 8 (running) created at:
  main.main()
      .../memory-model/busy/main.go:20 +0x27
==================
3 broken links
Found 2 data race(s)
exit status 66
```

The first race is on `done` (lines 16 and 21), the second on `report` (lines 15 and 23).
Replace the flag with a channel, and both writes are ordered before the read:

```go title="fixed/main.go"
package main

import (
	"fmt"
	"time"
)

func crawl(done chan<- struct{}, report *string) {
	time.Sleep(10 * time.Millisecond)
	*report = "3 broken links"
	close(done) // the close happens before the receive that sees it
}

func main() {
	var report string
	done := make(chan struct{})
	go crawl(done, &report)
	<-done
	fmt.Println(report)
}
```

```bash
go run -race ./fixed
```

```text
3 broken links
```

No report, exit status 0. `chan struct{}` carries no data; it exists only to signal.
An `atomic.Bool` for `done` would also be correct ([[once-atomic]]), but the loop would
still burn a CPU core while it waits; a channel receive parks the goroutine.

## Why "benign" races do not exist

In a data-race-free program, Go guarantees sequential consistency: the program behaves as
if all goroutines' operations were interleaved on a single processor. The model calls
this DRF-SC. A program with a race loses that guarantee for the racing accesses. Go is
stricter than C here (a race on a word-sized variable cannot corrupt unrelated memory),
but a race on a multi-word value (a string, a slice, an interface) can tear: a reader can
see the pointer from one write and the length from another, and crash or read the wrong
memory. A race on a map can crash the runtime with `concurrent map writes`.

> [!WARNING]
> "It works on my machine" is the symptom of a data race, not proof of its absence. Races
> show up under load, on more cores, on ARM servers, or after a compiler upgrade. Fix: run
> your tests with `go test -race` in CI, every time, and treat any report as a bug. A
> report that "only happens in tests" is still a real race in your code.

> [!NOTE]
> If `-race` fails with `go: -race requires cgo; enable cgo by setting CGO_ENABLED=1`,
> cgo is off, usually because no C compiler was found. Install gcc (mingw-w64 on Windows, the
> `build-essential` package on Debian or Ubuntu, Xcode command line tools on macOS) and
> check `go env CGO_ENABLED` prints `1`.

Running the race detector over tests is covered in [[coverage-race]], and linkcheck's
test suite runs under `-race` in [[step-6-tests]].
