---
title: Pipelines and fan-out, fan-in
---
A pipeline is a chain of stages connected by channels. Each stage is a group of
goroutines that receives values from an inbound channel, does one job with each, and
sends results on an outbound channel. The first stage (the source) only sends; the last
(the sink) only receives. Pipelines let each step run concurrently with the others and
let you add parallelism to just the slow step.

Two patterns go with it. **Fan-out** means several goroutines read from the same channel,
sharing the work. **Fan-in** means merging several channels into one.

## A link-checking pipeline

```go title="pipeline/main.go"
package main

import (
	"context"
	"fmt"
	"runtime"
	"strings"
	"sync"
	"time"
)

type Result struct {
	URL    string
	Status int
}

// generate emits each URL, stopping early if ctx is cancelled.
func generate(ctx context.Context, urls ...string) <-chan string {
	out := make(chan string)
	go func() {
		defer close(out)
		for _, u := range urls {
			select {
			case out <- u:
			case <-ctx.Done():
				return
			}
		}
	}()
	return out
}

// normalise trims and lower-cases each URL.
func normalise(ctx context.Context, in <-chan string) <-chan string {
	out := make(chan string)
	go func() {
		defer close(out)
		for u := range in {
			select {
			case out <- strings.ToLower(strings.TrimSpace(u)):
			case <-ctx.Done():
				return
			}
		}
	}()
	return out
}

// check pretends to fetch a URL: slow for some, 404 for "/missing" paths.
func check(ctx context.Context, in <-chan string) <-chan Result {
	out := make(chan Result)
	go func() {
		defer close(out)
		for u := range in {
			time.Sleep(time.Duration(len(u)) * time.Millisecond)
			r := Result{URL: u, Status: 200}
			if strings.HasSuffix(u, "/missing") {
				r.Status = 404
			}
			select {
			case out <- r:
			case <-ctx.Done():
				return
			}
		}
	}()
	return out
}

// merge fans in: it forwards every value from every input, then closes out.
func merge(ctx context.Context, ins ...<-chan Result) <-chan Result {
	out := make(chan Result)
	var wg sync.WaitGroup
	for _, in := range ins {
		wg.Go(func() {
			for r := range in {
				select {
				case out <- r:
				case <-ctx.Done():
					return
				}
			}
		})
	}
	go func() {
		wg.Wait()
		close(out)
	}()
	return out
}

func main() {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	urls := generate(ctx,
		" HTTPS://go.dev/ ", "https://go.dev/missing", "https://pkg.go.dev/",
		"https://go.dev/blog", "https://go.dev/doc", "https://go.dev/play")
	clean := normalise(ctx, urls)

	// Fan out: three check stages read the same input channel.
	results := merge(ctx, check(ctx, clean), check(ctx, clean), check(ctx, clean))

	for r := range results {
		fmt.Println(r.Status, r.URL)
	}
	fmt.Println("goroutines after a full run:", runtime.NumGoroutine())
}
```

```bash
go run ./pipeline
```

```text
200 https://go.dev/
200 https://pkg.go.dev/
404 https://go.dev/missing
200 https://go.dev/blog
200 https://go.dev/doc
200 https://go.dev/play
goroutines after a full run: 1
```

The order of results can differ between runs: three `check` goroutines run at once and
finish in whatever order their work allows. Fan-out trades input order for throughput.
If you need input order, carry an index in `Result` and sort at the end, or write into
`results[i]` as in [[waitgroup]].

## How it works

**Every stage has the same shape.** A function takes a context and an inbound
`<-chan T`, makes its own outbound channel, starts a goroutine, and returns the outbound
channel at once as receive-only. The goroutine ranges over the input and `defer
close(out)`. The stage that creates a channel is the only one that sends on it, so it is
the only one allowed to close it ([[channels]]).

**Closing cascades.** `generate` closes `urls` when it runs out. `normalise`'s `range`
then ends and it closes `clean`. All three `check` goroutines see `clean` closed and close
their outputs. `merge`'s forwarders finish, `wg.Wait()` returns and `results` is closed,
which ends `main`'s loop. No stage needs to know how many values there are.

**Fan-out is free.** Three goroutines ranging over one channel each receive different
values; a value is delivered to exactly one receiver. Adding workers to the slow stage is
just calling `check` more times.

**Fan-in needs a WaitGroup.** `merge` has several senders on `out`, so none of them may
close it. One extra goroutine waits for all forwarders and then closes `out`, the
multi-sender rule from [[channels]].

**Every send also selects on `ctx.Done()`.** A stage blocked on `out <- v` can only be
released by a receiver or by cancellation. That is what makes stopping early safe.

## Stopping early

A sink often does not want everything: stop at the first broken link, or after a time
budget. Copy `pipeline/main.go` to `earlystop/main.go` and replace `main` with:

```go title="earlystop/main.go"
func main() {
	ctx, cancel := context.WithCancel(context.Background())

	urls := generate(ctx,
		" HTTPS://go.dev/ ", "https://go.dev/missing", "https://pkg.go.dev/",
		"https://go.dev/blog", "https://go.dev/doc", "https://go.dev/play")
	clean := normalise(ctx, urls)
	results := merge(ctx, check(ctx, clean), check(ctx, clean), check(ctx, clean))

	for r := range results {
		if r.Status != 200 {
			fmt.Println("first broken link:", r.URL)
			break // stop reading: upstream senders are now stuck...
		}
	}
	fmt.Println("goroutines right after break:", runtime.NumGoroutine())
	cancel() // ...until cancel tells every stage to return
	time.Sleep(50 * time.Millisecond)
	fmt.Println("goroutines after cancel:", runtime.NumGoroutine())
}
```

```bash
go run ./earlystop
```

```text
first broken link: https://go.dev/missing
goroutines right after break: 8
goroutines after cancel: 1
```

After the `break`, nobody receives from `results`. Seven pipeline goroutines are still
alive besides `main`; each one either is blocked in a send already or will block at its
next send, and without cancellation they would stay blocked for the life of the program. `cancel()` closes
`ctx.Done()`, every blocked `select` takes its `<-ctx.Done()` case, each goroutine
returns, and its deferred `close` lets the next stage finish too. The `time.Sleep` is
only there so the count is taken after they have exited; the count right after the break
can vary with timing.

| Pattern | Shape | Use for |
|---|---|---|
| Stage | `func(ctx, <-chan In) <-chan Out` | One step of work, run concurrently with the others |
| Fan-out | Call the same stage N times on one input | Parallelising the slow step |
| Fan-in | `merge(ctx, ins...)` with a WaitGroup and one closer | Combining the fanned-out outputs |
| Cancellation | `select` on `out <- v` and `<-ctx.Done()` | Letting the sink stop early without leaking |

> [!WARNING]
> A stage that sends with a bare `out <- v` leaks when its consumer stops early.
> Symptom: memory and `runtime.NumGoroutine()` grow with every request that returns
> before draining its pipeline, while the program otherwise works. Fix: every send in
> every stage is a `select` with a `<-ctx.Done()` case, and the code that stops reading
> calls `cancel`, usually with `defer cancel()` right after creating the context.
> [[goroutine-leaks]] shows how to find such goroutines in a running program.

> [!NOTE]
> Unbuffered channels between stages keep each stage in lockstep with the next. A small
> buffer lets a fast stage run ahead when the next one has a slow item. It does not
> change the shape or the cancellation rules, and an unlimited buffer only hides a slow
> stage.

A crawler is a pipeline that feeds itself: checked pages produce new URLs to check. The
next stop gives the check stage a fixed number of workers ([[worker-pools]]), the shape
linkcheck uses in [[step-3-concurrent]].
