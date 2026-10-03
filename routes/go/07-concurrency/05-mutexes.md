---
title: Mutexes
---
A mutex (mutual exclusion lock) makes sure only one goroutine at a time runs a piece of
code, called the critical section. You need one whenever several goroutines read and
write the same variable: a counter, a map, a struct's fields. Channels hand data from one
goroutine to another; a mutex guards data that stays in one place and is touched by many.

`sync.Mutex` has two methods that matter: `Lock` and `Unlock`. Its zero value is an
unlocked mutex, ready to use.

## Lost updates

```go title="lost/main.go"
package main

import (
	"fmt"
	"sync"
)

func main() {
	var (
		mu      sync.Mutex
		unsafeN int
		safeN   int
		wg      sync.WaitGroup
	)
	for range 1000 {
		wg.Go(func() {
			for range 100 {
				unsafeN++ // data race: read, add, write, unprotected

				mu.Lock()
				safeN++
				mu.Unlock()
			}
		})
	}
	wg.Wait()
	fmt.Println("without lock:", unsafeN)
	fmt.Println("with lock:   ", safeN)
}
```

```bash
go run ./lost
```

```text
without lock: 98351
with lock:    100000
```

The first number is different on every run and almost never 100000. The second is
always 100000.

## How it works

`n++` is three steps: load `n`, add one, store `n`. Two goroutines on two cores can both
load 41, both compute 42, and both store 42: one increment is lost. Nothing crashes;
the total is just wrong, and by a different amount each time. This is a data race, defined
precisely in [[memory-model]].

`mu.Lock()` blocks while another goroutine holds the lock. Only the holder runs the code
between `Lock` and `Unlock`, so the load-add-store of `safeN` happens as one step from
every other goroutine's point of view. The memory model also guarantees that each
`Unlock` happens before the next `Lock` returns, so the next holder sees every write the
previous holder made, even on another core.

A mutex protects data only if every access to that data takes the lock. The compiler does
not know which mutex guards which field; that is a convention you write down.

## The real-world form: a type that guards its own state

Put the mutex next to the fields it guards, unexported, and lock it inside every method.
Callers then cannot forget to lock:

```go title="visited/main.go"
package main

import (
	"fmt"
	"sync"
)

// Visited records URLs that have been seen. It is safe for concurrent use.
type Visited struct {
	mu   sync.Mutex // guards seen
	seen map[string]bool
}

func NewVisited() *Visited {
	return &Visited{seen: make(map[string]bool)}
}

// Add marks url as seen and reports whether it was new.
// Check and insert happen under one lock, so exactly one caller wins.
func (v *Visited) Add(url string) bool {
	v.mu.Lock()
	defer v.mu.Unlock()
	if v.seen[url] {
		return false
	}
	v.seen[url] = true
	return true
}

func (v *Visited) Len() int {
	v.mu.Lock()
	defer v.mu.Unlock()
	return len(v.seen)
}

func main() {
	v := NewVisited()
	var (
		wg     sync.WaitGroup
		winsMu sync.Mutex
		wins   int
	)
	for range 50 {
		wg.Go(func() {
			for _, u := range []string{"/", "/about", "/blog", "/"} {
				if v.Add(u) {
					winsMu.Lock()
					wins++
					winsMu.Unlock()
				}
			}
		})
	}
	wg.Wait()
	fmt.Println("distinct:", v.Len(), "first-time adds:", wins)
}
```

```text
distinct: 3 first-time adds: 3
```

Fifty goroutines tried to add the same four URLs, and exactly three `Add` calls reported
a new URL. That works because the check (`v.seen[url]`) and the insert happen inside one
critical section. A version with separate `Has` and `Insert` methods, each locking on its
own, would let two goroutines both see "not seen" and both crawl the same page. This is
called check-then-act; the fix is always to make the check and the act one locked
operation.

The rules this type follows:

- **Methods use pointer receivers.** A value receiver would copy the struct, mutex
  included, and lock the copy ([[method-sets]]).
- **`defer mu.Unlock()` right after `Lock`.** Every return path, and a panic, releases the
  lock. The cost of `defer` is negligible since Go 1.14.
- **Comment what the mutex guards.** `// guards seen` is the only place that rule lives.
- **A plain Go map is not safe for concurrent use.** Concurrent writes, or a write during
  a read, can crash the program with `fatal error: concurrent map writes` or
  `concurrent map read and map write`. Guard every map shared between goroutines.

## RWMutex: many readers, one writer

`sync.RWMutex` lets any number of goroutines hold a read lock (`RLock`) at once, or one
goroutine hold the write lock (`Lock`):

```go title="rw/main.go"
package main

import (
	"fmt"
	"sync"
)

// Config is read constantly and replaced rarely.
type Config struct {
	mu        sync.RWMutex
	maxDepth  int
	userAgent string
}

func (c *Config) Get() (int, string) {
	c.mu.RLock() // many readers may hold this at once
	defer c.mu.RUnlock()
	return c.maxDepth, c.userAgent
}

func (c *Config) Set(depth int, ua string) {
	c.mu.Lock() // waits for all readers to leave, then excludes everyone
	defer c.mu.Unlock()
	c.maxDepth, c.userAgent = depth, ua
}

func main() {
	cfg := &Config{maxDepth: 2, userAgent: "linkcheck/0.1"}
	var wg sync.WaitGroup
	for range 4 {
		wg.Go(func() {
			for range 1000 {
				cfg.Get()
			}
		})
	}
	wg.Go(func() { cfg.Set(3, "linkcheck/0.2") })
	wg.Wait()
	fmt.Println(cfg.Get())
}
```

```text
3 linkcheck/0.2
```

When a writer is waiting, new readers block, so a steady stream of readers cannot starve
the writer. That same rule means a goroutine must never take `RLock` twice: if a writer
arrives between the two calls, the second `RLock` waits for the writer, the writer waits
for the first `RLock`, and both are stuck. An `RLock` also cannot be upgraded to `Lock`.

An `RWMutex` costs more per operation than a `Mutex`. It only wins when reads are much
more frequent than writes and the critical section is long enough for readers to overlap.
Start with `Mutex`; switch when a profile shows contention ([[pprof-cpu]]).

## Deadlocks you write yourself

Go's mutexes are not reentrant: a goroutine that already holds a lock and calls `Lock`
again waits for itself forever.

```go title="relock/main.go"
package main

import (
	"fmt"
	"sync"
)

type Counter struct {
	mu sync.Mutex
	n  map[string]int
}

func (c *Counter) Inc(key string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.n[key]++
}

// IncTwice locks, then calls Inc, which locks again.
func (c *Counter) IncTwice(key string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.Inc(key)
	c.Inc(key)
}

func main() {
	c := &Counter{n: map[string]int{}}
	c.IncTwice("x")
	fmt.Println(c.n["x"])
}
```

```text
fatal error: all goroutines are asleep - deadlock!

goroutine 1 [sync.Mutex.Lock]:
...
main.(*Counter).Inc(0x99aab1de30?, {0x7ff603cb6000, 0x1})
	.../mutexes/relock/main.go:14 +0x52
main.(*Counter).IncTwice(0x99aaad8070, {0x7ff603cb6000, 0x1})
	.../mutexes/relock/main.go:23 +0x85
main.main()
	.../mutexes/relock/main.go:29 +0x6f
exit status 2
```

(The `runtime` and `internal/sync` frames at the top of the trace are left out.) The
usual fix is a split: an unexported `incLocked` that assumes the caller holds the lock,
called by both exported methods, which do the locking. In a server the runtime cannot
report this deadlock, because other goroutines are still alive; the request just hangs.

The other classic is lock ordering: goroutine 1 locks A then B, goroutine 2 locks B then
A. Each holds one and waits for the other. Fix it by always acquiring locks in one global
order, or by never holding two locks at once.

Unlocking a mutex that is not locked is a fatal error that `recover` cannot catch:

```text
fatal error: sync: unlock of unlocked mutex
```

> [!WARNING]
> Holding a lock during slow work turns concurrent code back into sequential code.
> Symptom: ten workers are no faster than one, and a goroutine profile shows most of them
> in `sync.Mutex.Lock`. Fix: lock only around the shared data. Copy what you need out
> under the lock, unlock, then do the HTTP request, file write or channel send. Never
> send on a channel or call unknown code while holding a lock; the receiver may need the
> same lock.

> [!WARNING]
> Copying a struct that contains a mutex copies the lock state and gives you two
> independent locks guarding the same data. `go vet` reports it as
> `passes lock by value` or `copies lock value` ([[waitgroup]] shows the output). Pass and
> store such structs by pointer.

| Type and method | Does |
|---|---|
| `Mutex.Lock`, `Unlock` | Exclusive lock |
| `Mutex.TryLock` | Lock if free, report whether it did. Rarely correct; the docs warn that its use is often a sign of a deeper problem |
| `RWMutex.RLock`, `RUnlock` | Shared read lock |
| `RWMutex.Lock`, `Unlock` | Exclusive write lock |
| `sync.Map` | A map safe for concurrent use without your own lock. Faster than a locked map only for keys written once and read many times, or goroutines touching disjoint keys; otherwise use a map with a `Mutex` |

linkcheck's visited set has exactly this `Add`-reports-new shape. It has no mutex: only the
crawl loop in [[step-3-concurrent]] uses it. The per-host rate limiter in [[step-4-polite]] is
the type there that holds a mutex.
