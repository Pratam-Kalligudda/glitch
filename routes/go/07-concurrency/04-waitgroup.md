---
title: WaitGroup
---
A `sync.WaitGroup` waits for a set of goroutines to finish. It is a counter: each task
adds one, each finished task subtracts one, and `Wait` blocks until the counter is zero.
Use it when you need "all of these are done" and the goroutines either return nothing or
write their results somewhere you set up in advance.

Since Go 1.25, `wg.Go(f)` starts `f` in a new goroutine and counts it in one call:

```go title="gomethod/main.go"
package main

import (
	"fmt"
	"strings"
	"sync"
	"time"
)

func check(url string) string {
	time.Sleep(time.Duration(len(url)) * time.Millisecond) // pretend network work
	return strings.ToUpper(url)
}

func main() {
	urls := []string{"go.dev", "pkg.go.dev", "example.com"}
	results := make([]string, len(urls)) // one slot per goroutine

	var wg sync.WaitGroup
	for i, url := range urls {
		wg.Go(func() {
			results[i] = check(url) // each goroutine writes only its own index
		})
	}
	wg.Wait()

	for i, r := range results {
		fmt.Println(urls[i], "->", r)
	}
}
```

```bash
go run ./gomethod
```

```text
go.dev -> GO.DEV
pkg.go.dev -> PKG.GO.DEV
example.com -> EXAMPLE.COM
```

The goroutines finish in any order, but the output is always in input order because each
goroutine wrote to its own slot.

## How it works

`wg.Go(f)` is `wg.Add(1)` followed by `go` running `f` and then `wg.Done()`. `Wait`
blocks until every `f` has returned. Three rules make this correct:

1. **Count before you start.** `Go` (or `Add`) runs in the calling goroutine, before
   `Wait`. The docs put it as: when the counter is zero, a positive `Add` (or a `Go`) must
   happen before `Wait`. Once the counter is above zero, more tasks may be added at any
   time, so a task may itself call `wg.Go`.
2. **Wait gives you the results safely.** The memory model ([[memory-model]]) guarantees
   that the return of each `f` happens before the `Wait` it unblocks returns. So after
   `wg.Wait()`, `main` sees every write the goroutines made to `results`, with no extra
   locking.
3. **Disjoint writes do not race.** Different elements of a slice are different memory
   locations. Goroutine `i` writing `results[i]` while goroutine `j` writes `results[j]` is
   safe. Appending to a shared slice is not: `append` reads and writes the slice header
   that every goroutine shares ([[append-aliasing]]).

`wg.Go` captures `i` and `url` in a closure. Each loop iteration has its own variables
since Go 1.22 ([[loop-variables]]), so every goroutine sees its own values.

## The Add and Done form

Code written before Go 1.25, and code that tracks work that is not a new goroutine, uses
`Add` and `Done` directly:

```go title="classic/main.go"
package main

import (
	"fmt"
	"strings"
	"sync"
)

func main() {
	urls := []string{"go.dev", "pkg.go.dev", "example.com"}
	results := make([]string, len(urls))

	var wg sync.WaitGroup
	for i, url := range urls {
		wg.Add(1) // before the go statement
		go func() {
			defer wg.Done() // runs even if the work returns early
			results[i] = strings.ToUpper(url)
		}()
	}
	wg.Wait()
	fmt.Println(results)
}
```

```text
[GO.DEV PKG.GO.DEV EXAMPLE.COM]
```

`wg.Done()` is `wg.Add(-1)`. Defer it on the first line of the goroutine so every return
path decrements the counter; a path that forgets leaves `Wait` blocked forever. You can
`Add(len(urls))` once before the loop when you know the count up front.

`wg.Go` differs in one detail: if `f` panics, `Go` does not call `Done`. The docs say `f`
must not panic. A panicking goroutine crashes the program anyway ([[goroutines]]); not
calling `Done` stops `Wait` from returning and letting `main` exit with status 0 before the
crash is printed.

## What vet catches

Two WaitGroup mistakes are common enough that `go vet` ([[vet-fmt-fix]]) checks for them.
The first is calling `Add` inside the new goroutine:

```go title="addinside/main.go"
package main

import (
	"fmt"
	"sync"
)

func main() {
	var wg sync.WaitGroup
	for i := range 3 {
		go func() {
			wg.Add(1) // wrong: may run after wg.Wait has already returned
			defer wg.Done()
			fmt.Println("task", i)
		}()
	}
	wg.Wait()
	fmt.Println("all done?")
}
```

```bash
go vet ./addinside
```

```text
addinside\main.go:12:10: WaitGroup.Add called from inside new goroutine
```

(vet prints paths with the separator of your OS; this run was on Windows.) `main` reaches
`wg.Wait()` while the counter may still be zero, because none of the goroutines has run
its `Add` yet. `Wait` returns at once. In three runs on the same machine, the first
printed all three tasks and then `all done?`; the other two printed only `all done?`. The `waitgroup` analyzer was added to
vet in Go 1.25. `wg.Go` makes this mistake impossible.

The second is copying a WaitGroup:

```go title="byvalue/main.go"
package main

import (
	"fmt"
	"sync"
)

func work(id int, wg sync.WaitGroup) { // wrong: wg is a copy
	defer wg.Done()
	fmt.Println("work", id)
}

func main() {
	var wg sync.WaitGroup
	wg.Add(1)
	go work(1, wg)
	wg.Wait()
}
```

```bash
go vet ./byvalue
```

```text
byvalue\main.go:8:22: work passes lock by value: sync.WaitGroup contains sync.noCopy
byvalue\main.go:16:13: call of work copies lock value: sync.WaitGroup contains sync.noCopy
```

Run it anyway and it deadlocks:

```text
work 1
fatal error: all goroutines are asleep - deadlock!

goroutine 1 [sync.WaitGroup.Wait]:
...
```

(The rest of the trace, through the `sync` and `runtime` packages, is left out.) `work`
decremented its own copy; the counter `main` waits on stays at one. A WaitGroup, like a
Mutex, must not be copied after first use: pass `*sync.WaitGroup`, or better, keep the
WaitGroup in the function that calls `Wait` and let the goroutine closure use it, as the
examples above do. `sync.WaitGroup` contains a `noCopy` marker field so vet's `copylocks`
check can find copies ([[copying]]).

Calling `Done` more often than `Add` panics:

```text
panic: sync: negative WaitGroup counter
```

> [!WARNING]
> A WaitGroup tells you when goroutines finished, not whether they succeeded. Symptom:
> errors written to a shared variable get lost or overwritten, or several goroutines write
> the same `err` variable at once (a data race). Fix: give each goroutine its own result
> slot, as `results[i]` does, or use `errgroup` ([[errgroup]]), which collects the first
> error and cancels the rest.

| Call | Does |
|---|---|
| `wg.Go(f)` | Go 1.25: count one task and run `f` in a new goroutine |
| `wg.Add(n)` | Add `n` (may be negative) to the counter |
| `wg.Done()` | Subtract one |
| `wg.Wait()` | Block until the counter is zero |

linkcheck starts its fetch workers with `wg.Go`, closes the `jobs` channel and then calls
`wg.Wait()` in [[step-3-concurrent]].
