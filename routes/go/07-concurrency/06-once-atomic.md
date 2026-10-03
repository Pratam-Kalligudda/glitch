---
title: Once and atomics
---
Two smaller tools cover jobs where a full mutex is more than you need. `sync.Once` and its
helpers run initialisation exactly once, lazily, no matter how many goroutines ask for it
at the same moment. The `sync/atomic` package gives you single variables (counters,
flags, pointers) that many goroutines can read and update without a lock.

## Lazy, once-only initialisation

`sync.OnceValue(f)` (Go 1.21) returns a function. The first call runs `f` and remembers
its result; every later call, from any goroutine, returns that result without running `f`
again.

```go title="oncevalue/main.go"
package main

import (
	"fmt"
	"strings"
	"sync"
	"sync/atomic"
)

var builds atomic.Int32

// skipSchemes builds its table on first use, exactly once, however many
// goroutines call it at the same time.
var skipSchemes = sync.OnceValue(func() map[string]bool {
	builds.Add(1)
	m := make(map[string]bool)
	for _, s := range strings.Fields("mailto tel javascript data ftp") {
		m[s] = true
	}
	return m
})

func skip(link string) bool {
	scheme, _, found := strings.Cut(link, ":")
	return found && skipSchemes()[scheme]
}

func main() {
	links := []string{"/about", "mailto:me@example.com", "https://go.dev", "tel:123"}
	var wg sync.WaitGroup
	for range 10 {
		wg.Go(func() {
			for _, l := range links {
				skip(l)
			}
		})
	}
	wg.Wait()
	for _, l := range links {
		fmt.Printf("%-22s skip=%v\n", l, skip(l))
	}
	fmt.Println("table built", builds.Load(), "time")
}
```

```bash
go run ./oncevalue
```

```text
/about                 skip=false
mailto:me@example.com  skip=true
https://go.dev         skip=false
tel:123                skip=true
table built 1 time
```

Ten goroutines called `skipSchemes()` concurrently and the table was built once.

### How it works

If several goroutines make the first call at the same time, one runs `f` and the others
block until it returns. The memory model ([[memory-model]]) guarantees that the
completion of `f` happens before any call returns, so every caller sees the fully built
map, never a half-filled one. After that, each call is a fast check of an atomic flag.

Without `Once`, the usual hand-written version ("if the table is nil, build it") is a
data race: two goroutines can both see nil and both build, or one can see a non-nil map
that another goroutine is still filling.

| Helper | Use when |
|---|---|
| `sync.Once` with `once.Do(f)` | The oldest form. Store the result yourself in a variable next to the `Once` |
| `sync.OnceFunc(f)` | Go 1.21. A `func()` that runs `f` once: setup with no result |
| `sync.OnceValue(f)` | Go 1.21. `f` returns one value; every call returns it |
| `sync.OnceValues(f)` | Go 1.21. `f` returns two values, typically `(T, error)` |

### Panics and errors are remembered too

```go title="oncepanic/main.go"
package main

import (
	"errors"
	"fmt"
	"os"
	"sync"
)

func call(name string, f func()) {
	defer func() {
		if r := recover(); r != nil {
			fmt.Println(name, "panicked:", r)
		}
	}()
	f()
	fmt.Println(name, "returned normally")
}

func main() {
	var once sync.Once
	setup := func() { panic("setup failed") }
	call("Once.Do #1", func() { once.Do(setup) })
	call("Once.Do #2", func() { once.Do(setup) }) // setup does not run again

	f := sync.OnceFunc(func() { panic("setup failed") })
	call("OnceFunc #1", f)
	call("OnceFunc #2", f) // the same panic again

	readConfig := sync.OnceValues(func() ([]byte, error) {
		fmt.Println("reading config")
		return os.ReadFile("missing.json")
	})
	for range 2 {
		_, err := readConfig()
		fmt.Println("error is ErrNotExist:", errors.Is(err, os.ErrNotExist))
	}
}
```

```text
Once.Do #1 panicked: setup failed
Once.Do #2 returned normally
OnceFunc #1 panicked: setup failed
OnceFunc #2 panicked: setup failed
reading config
error is ErrNotExist: true
error is ErrNotExist: true
```

`once.Do` treats a panicking `f` as done: the second call returns normally and whatever
`setup` should have initialised stays unset. `OnceFunc`, `OnceValue` and `OnceValues`
are safer: they re-panic with the same value on every call, so the failure cannot be
silently skipped. An error returned by `OnceValues` is cached as well. The file was read
once; the second call got the same error without trying again. If a failure should be
retried, `Once` is the wrong tool; use a mutex and a "loaded" flag you only set on success.

## Atomic variables

The types in `sync/atomic` (Go 1.19) wrap one value and make every operation on it
indivisible: `atomic.Int32`, `atomic.Int64`, `atomic.Uint32`, `atomic.Uint64`,
`atomic.Uintptr`, `atomic.Bool`, `atomic.Pointer[T]` and `atomic.Value`. Their zero value
is ready to use.

```go title="counters/main.go"
package main

import (
	"fmt"
	"sync"
	"sync/atomic"
)

type Stats struct {
	checked atomic.Int64
	broken  atomic.Int64
	slowest atomic.Int64 // milliseconds
}

// observe raises slowest to ms if ms is larger, without a lock.
func (s *Stats) observe(ms int64) {
	for {
		cur := s.slowest.Load()
		if ms <= cur {
			return
		}
		if s.slowest.CompareAndSwap(cur, ms) {
			return
		}
		// Another goroutine changed slowest between Load and CompareAndSwap: retry.
	}
}

func main() {
	var s Stats
	var wg sync.WaitGroup
	for i := range 1000 {
		wg.Go(func() {
			s.checked.Add(1)
			if i%10 == 0 {
				s.broken.Add(1)
			}
			s.observe(int64(i % 377))
		})
	}
	wg.Wait()
	fmt.Println("checked:", s.checked.Load())
	fmt.Println("broken: ", s.broken.Load())
	fmt.Println("slowest:", s.slowest.Load(), "ms")
}
```

```text
checked: 1000
broken:  100
slowest: 376 ms
```

### How it works

`Add(1)` is a single hardware instruction (on amd64, `LOCK XADD`) that loads, adds and
stores with no other core able to step in between. Unlike `n++` in [[mutexes]], no update
is lost.

`CompareAndSwap(old, new)` (CAS) sets the value to `new` only if it still equals `old`,
and reports whether it did. That is how you build any read-modify-write that is not a
plain add: read the current value, compute the new one, and CAS it in. If another
goroutine got there first, the CAS fails and you loop with the fresh value. `observe`
uses it to keep a running maximum.

The memory model treats atomics as synchronising: if one atomic operation observes the
effect of another, the first happens before the second, and all atomic operations
behave as if they ran in one sequential order. So an atomic flag can safely publish data
written before the flag was set, but only if every access to the flag is atomic.

### Publishing a whole value: atomic.Pointer

To swap a multi-field value as a unit, build a new value and publish a pointer to it:

```go title="swap/main.go"
package main

import (
	"fmt"
	"sync"
	"sync/atomic"
)

type Config struct {
	MaxDepth  int
	UserAgent string
}

// current is replaced as a whole; a *Config is never modified after Store.
var current atomic.Pointer[Config]

func main() {
	current.Store(&Config{MaxDepth: 2, UserAgent: "linkcheck/0.1"})

	var wg sync.WaitGroup
	for range 4 {
		wg.Go(func() {
			for range 1000 {
				cfg := current.Load() // one consistent snapshot
				_ = cfg.MaxDepth + len(cfg.UserAgent)
			}
		})
	}
	wg.Go(func() {
		next := *current.Load() // copy, change the copy, publish it
		next.MaxDepth = 3
		current.Store(&next)
	})
	wg.Wait()
	fmt.Printf("%+v\n", *current.Load())
}
```

```text
{MaxDepth:3 UserAgent:linkcheck/0.1}
```

Readers never lock and always see either the old config or the new one, never a mix. The
rule that makes it safe: a `Config` is immutable once stored. Writing `cfg.MaxDepth = 3`
through a loaded pointer would be a data race with every reader. `atomic.Pointer[T]` is
type-safe; prefer it to `atomic.Value`, which holds `any` and panics if you store values
of different concrete types.

> [!WARNING]
> Two atomic operations in a row are not one atomic operation. Symptom: code like
> `if n.Load() < limit { n.Add(1) }` lets several goroutines pass the check together and
> overshoot `limit`, rarely and only under load. Fix: do the check and the update in one
> `CompareAndSwap` loop, as `observe` does, or use a mutex when the state is more than one
> variable. Atomics guard one word; a mutex guards an invariant across several fields.

> [!WARNING]
> Mixing atomic and plain access to the same variable is a data race. Symptom: the race
> detector reports it ([[memory-model]]), or a plain read sees a stale value forever.
> Fix: use the `atomic.Int64` style types rather than the older functions such as
> `atomic.AddInt64(&n, 1)`. A typed atomic has no plain read or write, so you cannot mix
> them by accident.

Atomics are the right tool for counters and flags. For anything bigger, a mutex is easier
to get right and usually just as fast. linkcheck counts checked and broken links with
`atomic.Int64` for its progress line in [[step-3-concurrent]].
