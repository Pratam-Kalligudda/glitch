---
title: Rate limiting
---
Rate limiting caps how often something happens: at most ten requests per second to one
host, at most one retry per second. It is a different limit from a worker pool's.
A pool bounds how many requests are in flight at once ([[worker-pools]]); a rate limit
bounds how many start per unit of time. A crawler needs both: eight workers can still hit
one small server with hundreds of requests a second if its pages are fast.

## The simplest limiter: a ticker

```go title="ticker/main.go"
package main

import (
	"fmt"
	"time"
)

func main() {
	start := time.Now()
	tick := time.NewTicker(50 * time.Millisecond)
	defer tick.Stop()

	for i := range 4 {
		<-tick.C // wait for the next tick before each request
		fmt.Printf("request %d at +%v\n", i, time.Since(start).Round(10*time.Millisecond))
	}
}
```

```bash
go run ./ticker
```

```text
request 0 at +50ms
request 1 at +100ms
request 2 at +150ms
request 3 at +200ms
```

Receiving from a ticker before each request spaces requests evenly. It is enough for one
loop, but it has limits: even the first request waits, it allows no bursts, every caller
must write its own `select` with `<-ctx.Done()` to stay cancellable, and a ticker keeps
firing while nobody needs it.

## A token bucket: golang.org/x/time/rate

The standard tool is `rate.Limiter` from the `golang.org/x/time` module, maintained by
the Go team:

```bash
go get golang.org/x/time@v0.16.0
```

```text title="go.mod"
module example.com/ratelimit

go 1.27

require golang.org/x/time v0.16.0
```

```go title="bucket/main.go"
package main

import (
	"context"
	"fmt"
	"time"

	"golang.org/x/time/rate"
)

func main() {
	// 10 events per second (one every 100ms), with bursts of up to 3.
	lim := rate.NewLimiter(rate.Every(100*time.Millisecond), 3)
	fmt.Println("limit:", lim.Limit(), "events/s, burst:", lim.Burst())

	ctx := context.Background()
	start := time.Now()
	for i := range 6 {
		if err := lim.Wait(ctx); err != nil {
			fmt.Println("wait:", err)
			return
		}
		fmt.Printf("request %d at +%v\n", i, time.Since(start).Round(10*time.Millisecond))
	}

	// Allow never waits: it reports whether a token is available right now.
	fmt.Println("Allow right away:", lim.Allow())

	// Wait gives up at once if the deadline is too close to ever get a token.
	short, cancel := context.WithTimeout(ctx, 20*time.Millisecond)
	defer cancel()
	t := time.Now()
	err := lim.Wait(short)
	fmt.Printf("Wait with 20ms budget: %v (after %v)\n", err, time.Since(t).Round(time.Millisecond))
}
```

```bash
go run ./bucket
```

```text
limit: 10 events/s, burst: 3
request 0 at +0s
request 1 at +0s
request 2 at +0s
request 3 at +100ms
request 4 at +200ms
request 5 at +300ms
Allow right away: false
Wait with 20ms budget: rate: Wait(n=1) would exceed context deadline (after 0s)
```

### How the token bucket works

The limiter is a bucket that holds at most `b` tokens (the burst) and refills at `r`
tokens per second. It starts full. Each event takes one token. If the bucket is empty,
the event must wait until the next token arrives.

- `rate.Every(100*time.Millisecond)` converts an interval into a `rate.Limit`, which is
  events per second as a `float64`: here 10.
- The first three requests emptied the full bucket at once: that is the burst. After
  that, one token arrives every 100 ms, so requests 3, 4 and 5 are spaced 100 ms apart.
  Over a long run the average is exactly the rate; the burst only allows short spikes.
- The limiter stores no timer and starts no goroutine. It records when it last updated
  and how many tokens it had, and computes the current count from the elapsed time on
  each call. An idle limiter costs nothing.

`Wait(ctx)` blocks until a token is available or `ctx` ends. It is smarter than a plain
sleep: when it can see that the next token will arrive after the context's deadline, it
returns an error at once instead of waiting and failing later. That is what happened with
the 20 ms budget, where the next token was about 100 ms away. Always pass the request's
context, so Ctrl-C ([[context]]) also interrupts goroutines that are waiting for a token.

| Method | Does |
|---|---|
| `rate.NewLimiter(r, b)` | A bucket of size `b`, refilled at `r` tokens per second, starting full |
| `rate.Every(d)` | The `Limit` for one event every `d` |
| `rate.Inf` | No limit: allows every event, even with burst 0 |
| `lim.Wait(ctx)` | Block until a token is available, or return an error if `ctx` ends or its deadline is too close |
| `lim.Allow()` | Take a token if one is available now; never blocks. For dropping or rejecting excess work |
| `lim.Reserve()` | Take a token now and get a `Reservation` that says how long to wait (`Delay()`) before acting; `Cancel()` gives it back |
| `lim.SetLimit(r)`, `lim.SetBurst(b)` | Change the rate at run time, such as slowing down after a 429 response |

## One limiter per host

Politeness is per server. A crawler checking links on fifty sites should not slow down
`example.com` because `go.dev` is busy. Keep one limiter per host in a map guarded by a
mutex:

```go title="perhost/main.go"
package main

import (
	"context"
	"fmt"
	"net/url"
	"sync"
	"time"

	"golang.org/x/time/rate"
)

// HostLimiter gives every host its own token bucket.
type HostLimiter struct {
	mu    sync.Mutex
	hosts map[string]*rate.Limiter // guarded by mu
	every time.Duration
	burst int
}

func NewHostLimiter(every time.Duration, burst int) *HostLimiter {
	return &HostLimiter{hosts: make(map[string]*rate.Limiter), every: every, burst: burst}
}

// Wait blocks until a request to rawURL's host is allowed, or ctx ends.
func (h *HostLimiter) Wait(ctx context.Context, rawURL string) error {
	u, err := url.Parse(rawURL)
	if err != nil {
		return err
	}
	h.mu.Lock()
	lim, ok := h.hosts[u.Host]
	if !ok {
		lim = rate.NewLimiter(rate.Every(h.every), h.burst)
		h.hosts[u.Host] = lim
	}
	h.mu.Unlock() // never hold mu while waiting: other hosts must not queue behind us
	return lim.Wait(ctx)
}

func main() {
	hl := NewHostLimiter(100*time.Millisecond, 1)
	urls := []string{
		"https://go.dev/a", "https://go.dev/b", "https://go.dev/c",
		"https://example.com/a", "https://example.com/b",
	}

	start := time.Now()
	var mu sync.Mutex
	var lines []string
	var wg sync.WaitGroup
	for _, u := range urls {
		wg.Go(func() {
			if err := hl.Wait(context.Background(), u); err != nil {
				return
			}
			mu.Lock()
			lines = append(lines, fmt.Sprintf("+%-6v %s", time.Since(start).Round(10*time.Millisecond), u))
			mu.Unlock()
		})
	}
	wg.Wait()
	for _, l := range lines {
		fmt.Println(l)
	}
}
```

```text
+0s     https://example.com/b
+0s     https://go.dev/c
+100ms  https://go.dev/b
+100ms  https://example.com/a
+200ms  https://go.dev/a
```

Which URL of each host goes first changes between runs; the spacing does not. Each host
got one request at once and then one every 100 ms, independently: `example.com` finished
at 100 ms while `go.dev` needed 200 ms for its three.

The mutex guards only the map lookup ([[mutexes]]). `rate.Limiter` is itself safe for
concurrent use, so `Wait` runs outside the lock; holding `mu` while waiting would make
every host wait behind the slowest one. `url.Parse` is covered in [[url-parsing]]. In a
long-running process this map grows with every host ever seen; a crawler that runs once
and exits can ignore that, while a server would evict idle entries.

> [!WARNING]
> Creating the limiter where you use it, such as `rate.NewLimiter(...)` inside the fetch
> function. Symptom: no limiting at all. Every call gets a brand-new, full bucket, so
> every request goes through at once and the remote server still sees a flood. Fix:
> create limiters once, with the crawler, and share them (one per host, as above) between
> all workers.

> [!WARNING]
> Calling `lim.Wait(context.Background())` inside workers. Symptom: after Ctrl-C the
> program does not exit until every queued worker has received its token, which can take
> minutes on a slow rate. Fix: pass the crawl's context, and treat the error from `Wait`
> as "stop now".

> [!NOTE]
> A server can tell you its own limit. HTTP 429 Too Many Requests often comes with a
> `Retry-After` header giving the seconds to wait. A polite client honours it, for
> example by lowering that host's limiter with `SetLimit` and retrying later. Reading
> response headers is covered in [[http-client]].

linkcheck adds exactly this per-host limiter, with the rate as a flag, in
[[step-4-polite]].
