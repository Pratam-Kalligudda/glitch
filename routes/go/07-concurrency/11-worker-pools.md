---
title: Worker pools and bounded concurrency
done_when: "`go run ./pool` reports a peak in flight equal to the worker count, and the run with a budget stops early without hanging."
---
A worker pool is a fixed number of goroutines that take jobs from one channel and send
results on another. It bounds concurrency: however many jobs there are, at most N run at
once. Goroutines are cheap, but what they do is not. Ten thousand concurrent HTTP requests
exhaust file descriptors, trip the remote server's rate limits and use ten thousand
buffers' worth of memory. A pool turns "as fast as possible" into "N at a time".

This is the shape a crawler needs: a jobs channel of URLs, N fetch workers, a results
channel, and a context that can stop all of it.

## A bounded link checker

```go title="pool/main.go"
package main

import (
	"context"
	"fmt"
	"sync"
	"sync/atomic"
	"time"
)

type Result struct {
	URL    string
	Status int
	Err    error
}

// inFlight and peak prove the bound: peak never exceeds the worker count.
var inFlight, peak atomic.Int32

// fetch stands in for an HTTP GET that takes 50ms and honours ctx.
func fetch(ctx context.Context, url string) (int, error) {
	n := inFlight.Add(1)
	defer inFlight.Add(-1)
	for p := peak.Load(); n > p && !peak.CompareAndSwap(p, n); p = peak.Load() {
	}
	select {
	case <-time.After(50 * time.Millisecond):
		return 200, nil
	case <-ctx.Done():
		return 0, ctx.Err()
	}
}

// checkAll checks urls with at most workers requests in flight.
func checkAll(ctx context.Context, urls []string, workers int) <-chan Result {
	jobs := make(chan string)
	results := make(chan Result)

	// Producer: feed jobs, stop early if cancelled.
	go func() {
		defer close(jobs)
		for _, u := range urls {
			select {
			case jobs <- u:
			case <-ctx.Done():
				return
			}
		}
	}()

	// A fixed number of workers share the jobs channel.
	var wg sync.WaitGroup
	for range workers {
		wg.Go(func() {
			for u := range jobs {
				status, err := fetch(ctx, u)
				select {
				case results <- Result{URL: u, Status: status, Err: err}:
				case <-ctx.Done():
					return
				}
			}
		})
	}

	// Close results once every worker has returned.
	go func() {
		wg.Wait()
		close(results)
	}()
	return results
}

func main() {
	var urls []string
	for i := range 20 {
		urls = append(urls, fmt.Sprintf("https://example.com/page/%d", i))
	}

	start := time.Now()
	ok := 0
	for r := range checkAll(context.Background(), urls, 5) {
		if r.Err == nil && r.Status == 200 {
			ok++
		}
	}
	fmt.Printf("checked %d/%d in %v, peak in flight: %d\n",
		ok, len(urls), time.Since(start).Round(10*time.Millisecond), peak.Load())

	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Millisecond)
	defer cancel()
	ok, failed := 0, 0
	for r := range checkAll(ctx, urls, 5) {
		if r.Err != nil {
			failed++
		} else {
			ok++
		}
	}
	fmt.Printf("with a 120ms budget: %d ok, %d cancelled, %d never reported\n",
		ok, failed, len(urls)-ok-failed)
}
```

```bash
go run ./pool
```

```text
checked 20/20 in 200ms, peak in flight: 5
with a 120ms budget: 10 ok, 2 cancelled, 8 never reported
```

Twenty 50 ms jobs on five workers take four rounds: 200 ms. Never more than five ran at
once. With a 120 ms budget, two full rounds (ten jobs) finished. The third round's five
workers were cut off at 120 ms; how many of their "cancelled" results get through before
the workers notice `ctx.Done()` varies between runs, because `select` picks randomly
between two ready cases ([[select]]). The rest were never sent to a worker.

## How it works

`checkAll` is the pipeline from [[pipelines]] with the slow stage fanned out to a fixed
size:

1. **One producer** sends each URL on `jobs` and closes it when done. It is the only
   sender on `jobs`, so it owns the close.
2. **N workers** range over `jobs`. A channel delivers each value to exactly one
   receiver, so the jobs are shared without any locking. When `jobs` is closed and empty,
   each worker's loop ends.
3. **One closer** waits for every worker and closes `results`. Workers never close
   `results` themselves: there are N senders.
4. **The caller** ranges over `results` until it is closed.
5. **Cancellation** reaches every goroutine that might wait: the producer's send, each
   worker's `fetch`, and each worker's send of its result. Whatever stage is blocked, it
   returns, and the closes cascade to the caller's `range`.

`checkAll` returns the channel immediately and does the work in the background, so the
caller can print progress while results stream in. The number of workers is the only knob
for concurrency; the number of URLs does not change how many goroutines exist.

## Bounding without a pool: a semaphore

When the work is "one goroutine per item" and you only need a ceiling, a buffered channel
works as a counting semaphore. Sending takes a slot; receiving gives it back:

```go title="semaphore/main.go"
package main

import (
	"fmt"
	"sync"
	"sync/atomic"
	"time"
)

func main() {
	const limit = 3
	sem := make(chan struct{}, limit) // a counting semaphore with 3 slots

	var inFlight, peak atomic.Int32
	var wg sync.WaitGroup
	start := time.Now()
	for range 10 {
		sem <- struct{}{} // acquire: blocks while 3 are running
		wg.Go(func() {
			defer func() { <-sem }() // release
			n := inFlight.Add(1)
			for p := peak.Load(); n > p && !peak.CompareAndSwap(p, n); p = peak.Load() {
			}
			time.Sleep(30 * time.Millisecond)
			inFlight.Add(-1)
		})
	}
	wg.Wait()
	fmt.Printf("10 tasks, limit %d: peak %d, took %v\n",
		limit, peak.Load(), time.Since(start).Round(10*time.Millisecond))
}
```

```text
10 tasks, limit 3: peak 3, took 120ms
```

The buffer holds three tokens, so the fourth `sem <- struct{}{}` blocks until a task
releases one. The memory model's rule for buffered channels (the k-th receive happens
before the (k+C)-th send completes, [[memory-model]]) is exactly what makes this a correct
semaphore. Acquiring **before** `wg.Go` matters: the loop itself waits, so at most
`limit + 1` goroutines ever exist. Acquiring inside the goroutine would still bound the
work but would start all ten goroutines at once.

| Approach | Goroutines | Best for |
|---|---|---|
| Worker pool | Exactly N, long-lived | A stream of jobs, results on a channel, a crawler |
| Semaphore channel | One per item, at most N running | A known list of independent tasks |
| `errgroup` with `SetLimit(n)` | One per item, at most N running | Tasks that can fail, where the first error should stop the rest; see [[errgroup]] |
| `golang.org/x/sync/semaphore` | Your choice | Weighted limits, such as "total bytes in flight" |

## Choosing N

There is no universal number. For CPU-bound work, `runtime.GOMAXPROCS(0)` workers keep
every core busy and more only add switching. For I/O-bound work like fetching pages, the
limit is set by the other side: what the remote server tolerates, your file descriptor
limit, and your bandwidth. Make N a flag, start small, and measure.
Being polite to one host is a separate limit, per host, covered in [[rate-limiting]].

> [!WARNING]
> Starting one goroutine per item with no bound. Symptom: works on a 20-link test page,
> then on a real site fails with dial errors (`too many open files` on Linux and macOS), a
> burst of HTTP 429 and 503 responses, or a memory spike. Fix: route the work through
> a fixed pool or a semaphore, and expose the limit as a setting.

> [!WARNING]
> Waiting for the workers before reading their results. Symptom: calling `wg.Wait()` in
> the caller and then ranging over an unbuffered `results` channel deadlocks: the workers
> are blocked sending, and the caller is blocked waiting for them. With nothing else
> running you get `fatal error: all goroutines are asleep - deadlock!`; in a server it
> just hangs. Fix: wait and close in a separate goroutine, as `checkAll` does, and read
> results in the caller.

linkcheck's crawler is this pool, with discovered links fed back in as new jobs and the
context coming from Ctrl-C, in [[step-3-concurrent]]; the per-host limit joins it in
[[step-4-polite]].
