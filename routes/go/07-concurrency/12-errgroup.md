---
title: errgroup
---
`golang.org/x/sync/errgroup` is a `WaitGroup` for tasks that can fail. An
`errgroup.Group` starts goroutines that return an `error`, waits for all of them, and
returns the first error. Created with `WithContext`, it also cancels a shared context as
soon as one task fails, so the others stop instead of finishing work nobody will use. With
`SetLimit` it bounds how many run at once. That is the three things the last three stops
built by hand (waiting, cancellation, a bound) in one small type.

`errgroup` lives in the `golang.org/x/sync` module, maintained by the Go team outside the
standard library:

```bash
go get golang.org/x/sync@v0.23.0
```

```text title="go.mod"
module example.com/errgroupdemo

go 1.27

require golang.org/x/sync v0.23.0
```

## First error wins, the rest are cancelled

```go title="first/main.go"
package main

import (
	"context"
	"errors"
	"fmt"
	"time"

	"golang.org/x/sync/errgroup"
)

var errDNS = errors.New("no such host")

// fetch takes d, fails for "bad.example", and stops early if ctx ends.
func fetch(ctx context.Context, host string, d time.Duration) (int, error) {
	if host == "bad.example" {
		time.Sleep(20 * time.Millisecond)
		return 0, fmt.Errorf("fetch %s: %w", host, errDNS)
	}
	select {
	case <-time.After(d):
		return 200, nil
	case <-ctx.Done():
		return 0, ctx.Err()
	}
}

func main() {
	hosts := []string{"go.dev", "bad.example", "pkg.go.dev", "example.com", "golang.org"}
	statuses := make([]int, len(hosts))

	start := time.Now()
	g, ctx := errgroup.WithContext(context.Background())
	g.SetLimit(3) // at most 3 fetches at once

	for i, h := range hosts {
		g.Go(func() error {
			status, err := fetch(ctx, h, 100*time.Millisecond)
			statuses[i] = status
			if err != nil && !errors.Is(err, context.Canceled) {
				fmt.Printf("%-12s failed after %v\n", h, time.Since(start).Round(10*time.Millisecond))
			}
			return err
		})
	}

	err := g.Wait()
	fmt.Println("Wait:", err)
	fmt.Println("is errDNS:", errors.Is(err, errDNS))
	fmt.Println("ctx cause:", context.Cause(ctx))
	fmt.Println("statuses:", statuses)
	fmt.Println("total:", time.Since(start).Round(10*time.Millisecond))
}
```

```bash
go run ./first
```

```text
bad.example  failed after 20ms
Wait: fetch bad.example: no such host
is errDNS: true
ctx cause: fetch bad.example: no such host
statuses: [0 0 0 0 0]
total: 20ms
```

The whole group finished in 20 ms, not the 200 ms that two rounds of 100 ms fetches would
take. The first failure stopped everything.

## How it works

The source of `errgroup` is about 150 lines; what it does, step by step:

1. `errgroup.WithContext(parent)` creates the group and a child context with
   `context.WithCancelCause` ([[context]]).
2. `g.SetLimit(3)` gives the group a semaphore channel with three slots, the same
   buffered-channel semaphore as in [[worker-pools]].
3. `g.Go(f)` takes a slot (blocking the loop while three tasks run), adds one to an
   internal `sync.WaitGroup`, and starts `f` in a new goroutine. When `f` returns, the
   slot is released and the WaitGroup decremented.
4. The first `f` to return a non-nil error stores it (under a `sync.Once`, so only the
   first counts) and cancels the context with that error as the cause. That is why
   `context.Cause(ctx)` prints the DNS error rather than just `context canceled`.
5. Every other task is selecting on `ctx.Done()` inside `fetch`, so it returns at once.
   The loop was blocked in `g.Go` for a free slot; as slots free up it starts the
   remaining tasks, which see a cancelled context and return immediately.
6. `g.Wait()` waits for every goroutine, cancels the context (if it is not cancelled
   already), and returns the first error. Later errors, including the `context.Canceled`
   errors from the stopped tasks, are discarded.

Results go into `statuses[i]`, one slot per task, exactly as in [[waitgroup]]: `Wait`
returning guarantees every write is visible.

Two details from the docs and source:

- **The context is cancelled when `Wait` returns**, even if every task succeeded. Do not
  use `ctx` from `WithContext` for work after `Wait`; use the parent.
- **A panic in a task is not caught.** It crashes the program like any goroutine panic
  ([[goroutines]]). The source explains that propagating it to `Wait` would hide the
  stack and could deadlock.

## TryGo and the zero Group

```go title="trygo/main.go"
package main

import (
	"fmt"
	"time"

	"golang.org/x/sync/errgroup"
)

func main() {
	var g errgroup.Group // the zero Group: no context, no limit until SetLimit
	g.SetLimit(2)

	for i := range 4 {
		started := g.TryGo(func() error {
			time.Sleep(20 * time.Millisecond)
			return nil
		})
		fmt.Println("task", i, "started:", started)
	}
	fmt.Println("Wait:", g.Wait())
}
```

```text
task 0 started: true
task 1 started: true
task 2 started: false
task 3 started: false
Wait: <nil>
```

A zero `errgroup.Group` is ready to use. It collects the first error but cancels nothing,
because it has no context. `TryGo` starts the task only if a slot is free and reports
whether it did, instead of blocking; use it when the caller has something better to do
than wait, such as queueing the task or shedding load.

| Method | Does |
|---|---|
| `errgroup.WithContext(ctx)` | A group plus a child context cancelled on the first error or when `Wait` returns |
| `g.Go(f)` | Start `f`; blocks while the limit is reached |
| `g.TryGo(f)` | Start `f` only if under the limit; reports whether it started |
| `g.SetLimit(n)` | At most `n` active tasks. Negative means no limit. Panics if tasks are active |
| `g.Wait()` | Wait for all tasks; return the first non-nil error |

## When errgroup fits, and when it does not

errgroup's model is "all of these must succeed". A link checker needs care here: a 404 is
not an error of the crawl, it is a result. If `fetch` returned an `error` for every broken
link, the first 404 would cancel the whole crawl. Return broken links as data, in a
`Result` value like the one in [[worker-pools]], and return an `error` from a task only
for failures that should stop everything, such as a full disk or a cancelled context.

> [!WARNING]
> Passing the parent context into the tasks instead of the one `WithContext` returned.
> Symptom: the group still returns the first error, but only after every other task has
> run to completion. Changing `fetch(ctx, ...)` to `fetch(context.Background(), ...)` in
> `first/main.go` prints `statuses: [200 0 200 200 200]` and `total: 200ms`: four
> fetches nobody needed. Fix: shadow the name, `g, ctx := errgroup.WithContext(ctx)`, so
> the only `ctx` in scope inside the tasks is the group's.

> [!WARNING]
> Writing results to a shared slice with `append`, or to a shared variable, from inside
> `g.Go`. Symptom: lost results or a race report under `-race` ([[memory-model]]). Fix:
> preallocate and write to your own index, or send results on a channel that one
> goroutine reads.

linkcheck's `--check-tcp` preflight in [[step-4-polite]] is an "all must succeed" check,
the kind of job errgroup is built for. The crawl itself, where broken links are results,
keeps the worker pool from [[step-3-concurrent]].
