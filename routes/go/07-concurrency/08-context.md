---
title: "context: cancellation and deadlines"
---
A `context.Context` carries a cancellation signal and an optional deadline through a call
chain and across goroutines. When the user presses Ctrl-C, a client disconnects or a time
budget runs out, every goroutine working on that request needs to stop. Go has no way to
kill a goroutine from outside, so stopping is cooperative: the code doing the work checks
its context and returns. The `context` package is the standard way to pass that "please
stop" down to every function involved.

The conventions, from the package documentation:

- A function that does I/O or may block takes `ctx context.Context` as its **first
  parameter**, named `ctx`.
- Do not store a context in a struct; pass it to each call that needs it.
- Never pass a nil context. Use `context.Background()` at the top of `main`, tests and
  servers' startup, or `context.TODO()` as a placeholder while you have not plumbed one
  through yet.

## A deadline

```go title="timeout/main.go"
package main

import (
	"context"
	"errors"
	"fmt"
	"time"
)

// fetch pretends to download a page that takes d. It gives up as soon as
// ctx is done.
func fetch(ctx context.Context, url string, d time.Duration) (string, error) {
	select {
	case <-time.After(d):
		return "body of " + url, nil
	case <-ctx.Done():
		return "", fmt.Errorf("fetch %s: %w", url, ctx.Err())
	}
}

func main() {
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()

	body, err := fetch(ctx, "/fast", 10*time.Millisecond)
	fmt.Printf("%q %v\n", body, err)

	body, err = fetch(ctx, "/slow", time.Second)
	fmt.Printf("%q %v\n", body, err)
	fmt.Println("deadline exceeded:", errors.Is(err, context.DeadlineExceeded))

	deadline, ok := ctx.Deadline()
	fmt.Println("had deadline:", ok, "passed:", time.Now().After(deadline))
}
```

```bash
go run ./timeout
```

```text
"body of /fast" <nil>
"" fetch /slow: context deadline exceeded
deadline exceeded: true
had deadline: true passed: true
```

The budget of 50 ms covers both calls together. `/fast` took 10 ms; `/slow` was given
the remaining 40 ms and stopped there, not after a second.

## How it works

A `Context` is an interface with four methods:

| Method | Returns |
|---|---|
| `Done() <-chan struct{}` | A channel that is closed when the context is cancelled or its deadline passes. Never closed for `Background()` |
| `Err() error` | `nil` while the context is live; afterwards `context.Canceled` or `context.DeadlineExceeded` |
| `Deadline() (time.Time, bool)` | The deadline, and whether there is one |
| `Value(key any) any` | A request-scoped value; see [[context-values]] |

Contexts form a tree. `WithCancel`, `WithTimeout` and `WithDeadline` take a parent and
return a child plus a `cancel` function. Cancelling a context closes its `Done` channel
and cancels all of its descendants, but never its parent. A child's deadline is the
earlier of its own and its parent's.

`Done` is a closed channel, so it works as a broadcast ([[channels]]): every goroutine
selecting on `<-ctx.Done()` wakes at once. A blocking operation waits in a `select` with
a `<-ctx.Done()` case, as `fetch` does. A loop that does CPU work checks
`if err := ctx.Err(); err != nil { return err }` between iterations.

Library code does the waiting for you. An HTTP request made with
`http.NewRequestWithContext(ctx, ...)` is aborted when `ctx` ends ([[http-client]]), and
`signal.NotifyContext` gives you a context cancelled by Ctrl-C ([[signals]]).

```go title="tree/main.go"
package main

import (
	"context"
	"fmt"
	"sync"
	"time"
)

func worker(ctx context.Context, name string, wg *sync.WaitGroup) {
	defer wg.Done()
	<-ctx.Done()
	fmt.Printf("%-8s stopped: %v\n", name, ctx.Err())
}

func main() {
	root, cancelRoot := context.WithCancel(context.Background())
	defer cancelRoot()

	crawl, cancelCrawl := context.WithCancel(root)
	defer cancelCrawl()
	page, cancelPage := context.WithTimeout(crawl, 20*time.Millisecond)
	defer cancelPage()

	var wg sync.WaitGroup
	wg.Add(3)
	go worker(root, "root", &wg)
	go worker(crawl, "crawl", &wg)
	go worker(page, "page", &wg)

	time.Sleep(50 * time.Millisecond) // the page timeout fires first
	cancelCrawl()                     // cancels crawl, not root
	time.Sleep(10 * time.Millisecond)
	fmt.Println("root still alive:", root.Err() == nil)
	cancelRoot()
	wg.Wait()
}
```

```text
page     stopped: context deadline exceeded
crawl    stopped: context canceled
root still alive: true
root     stopped: context canceled
```

The page context's own timeout ended it first. Cancelling `crawl` stopped its subtree
and left `root` alive. The `time.Sleep` calls only order the demonstration.

## Saying why: causes

`ctx.Err()` only ever says "canceled" or "deadline exceeded". `WithCancelCause` (Go 1.20)
lets the canceller record a reason, which `context.Cause` reads back:

```go title="cause/main.go"
package main

import (
	"context"
	"errors"
	"fmt"
	"time"
)

var errTooManyBroken = errors.New("more than 10 broken links")

func main() {
	ctx, cancel := context.WithCancelCause(context.Background())
	cancel(errTooManyBroken)
	cancel(errors.New("ignored")) // only the first cancel sets the cause

	fmt.Println("Err:  ", ctx.Err())
	fmt.Println("Cause:", context.Cause(ctx))

	tctx, tcancel := context.WithTimeoutCause(context.Background(),
		10*time.Millisecond, errors.New("crawl budget of 10ms used up"))
	defer tcancel()
	<-tctx.Done()
	fmt.Println("Err:  ", tctx.Err())
	fmt.Println("Cause:", context.Cause(tctx))

	plain, pcancel := context.WithCancel(context.Background())
	pcancel()
	fmt.Println("Cause without a cause:", context.Cause(plain))
}
```

```text
Err:   context canceled
Cause: more than 10 broken links
Err:   context deadline exceeded
Cause: crawl budget of 10ms used up
Cause without a cause: context canceled
```

`Err` keeps returning the standard values, so existing `errors.Is(err,
context.Canceled)` checks keep working; `Cause` adds the detail. Without a recorded
cause, `Cause` returns the same as `Err`. `WithDeadlineCause` and `WithTimeoutCause`
(Go 1.21) set the cause used when the timer fires. Calling a `CancelCauseFunc` with `nil`
sets the cause to `context.Canceled`.

## Running code when a context ends, and detaching from it

```go title="afterfunc/main.go"
package main

import (
	"context"
	"fmt"
	"time"
)

func main() {
	ctx, cancel := context.WithCancel(context.Background())

	// AfterFunc runs its function in a new goroutine once ctx is done.
	saved := make(chan struct{})
	stop := context.AfterFunc(ctx, func() {
		fmt.Println("AfterFunc: saving partial report")
		close(saved)
	})

	// A second registration that is unregistered before ctx ends.
	stop2 := context.AfterFunc(ctx, func() { fmt.Println("never printed") })
	fmt.Println("stop2 unregistered it:", stop2())

	// WithoutCancel ignores the parent's cancellation (and has no deadline).
	cleanup := context.WithoutCancel(ctx)

	cancel()
	<-saved
	fmt.Println("stop after it ran:", stop())
	fmt.Println("ctx:    ", ctx.Err())
	fmt.Println("cleanup:", cleanup.Err())

	// Give detached work its own bound.
	cleanupCtx, cancelCleanup := context.WithTimeout(cleanup, time.Second)
	defer cancelCleanup()
	fmt.Println("cleanup with its own timeout alive:", cleanupCtx.Err() == nil)
}
```

```text
stop2 unregistered it: true
AfterFunc: saving partial report
stop after it ran: false
ctx:      context canceled
cleanup: <nil>
cleanup with its own timeout alive: true
```

`context.AfterFunc(ctx, f)` (Go 1.21) arranges for `f` to run in its own goroutine once
`ctx` is done, without you starting a goroutine that sits on `<-ctx.Done()`. The returned
`stop` unregisters `f` and reports `true` if that prevented it from running; `false` means
it had already started (or `stop` was called before).

`context.WithoutCancel(ctx)` (Go 1.21) returns a child that keeps the parent's values but
is never cancelled and has no deadline. Use it for work that must finish after the
request that started it ends: writing the partial report after Ctrl-C, flushing a log.
Always give such work its own timeout, as the last lines do, or it can run forever.

| Function | Gives you |
|---|---|
| `Background()`, `TODO()` | An empty root context, never cancelled |
| `WithCancel(parent)` | A child and `cancel()` |
| `WithTimeout(parent, d)`, `WithDeadline(parent, t)` | A child that cancels itself at a time, and `cancel()` |
| `WithCancelCause(parent)` | Go 1.20. A child and `cancel(cause error)` |
| `WithTimeoutCause`, `WithDeadlineCause` | Go 1.21. Like the timeout forms, with a cause for the timeout |
| `Cause(ctx)` | Go 1.20. The recorded cause, or `ctx.Err()` |
| `AfterFunc(ctx, f)` | Go 1.21. Run `f` once `ctx` is done; returns `stop` |
| `WithoutCancel(parent)` | Go 1.21. A child that keeps values but not cancellation or deadline |

> [!WARNING]
> Every `cancel` returned by `WithCancel`, `WithTimeout` or `WithDeadline` must be called.
> The package docs: failing to call it leaks the child and its children until the parent
> is cancelled or the timer fires. With a long-lived parent such as `Background()` and no
> timeout, that is forever. Symptom: memory that grows with every
> request, and this vet report:
>
> ```text
> lostcancel\main.go:10:7: the cancel function returned by context.WithTimeout should be called, not discarded, to avoid a context leak
> ```
>
> Fix: write `defer cancel()` on the line after you create the context, even when the
> timeout will normally fire. Calling `cancel` more than once is safe.

> [!WARNING]
> A context only stops code that checks it. Symptom: Ctrl-C or a timeout "does nothing"
> and the program keeps working until the slow operation finishes. Fix: pass `ctx` all the
> way down, use the context-aware forms of library calls (`NewRequestWithContext`,
> `QueryContext`, `DialContext`), and in your own blocking code select on `<-ctx.Done()`
> next to every channel operation that might wait.

linkcheck's whole crawl runs under one context from `signal.NotifyContext`, so Ctrl-C
stops every worker and still prints a partial report, in [[step-3-concurrent]]; per-request
timeouts are added in [[step-4-polite]].
