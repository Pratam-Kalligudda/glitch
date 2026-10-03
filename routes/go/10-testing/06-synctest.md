---
title: Testing concurrent code with synctest
done_when: "A test of code that waits seconds (a backoff, a timeout, a ticker) finishes in milliseconds, asserts the exact elapsed time, and passes under `go test -race`."
---
Concurrent code is slow and nondeterministic to test. Code that retries after one, two and four seconds takes seven seconds to test with the real clock. A test that "sleeps a bit and hopes the goroutine is done" is slow when it works and flaky when it does not. The `testing/synctest` package (generally available since Go 1.25) removes both problems: it runs a test in a **bubble** with a fake clock, and it can tell when every goroutine in the bubble is stuck waiting, so it can move the clock forward by itself.

## The problem: real time

Here is a retry helper, the kind linkcheck needs for flaky links:

```text title="go.mod"
module example.com/synctest-demo

go 1.27
```

```go title="retry.go"
// Package retry runs an operation again after a growing delay.
package retry

import (
	"context"
	"time"
)

// Do calls fn up to attempts times. After a failure it waits base, then
// 2*base, then 4*base, and so on, and gives up early if ctx ends.
func Do(ctx context.Context, attempts int, base time.Duration, fn func(context.Context) error) error {
	var err error
	delay := base
	for i := 0; i < attempts; i++ {
		if err = fn(ctx); err == nil {
			return nil
		}
		if i == attempts-1 {
			break
		}
		select {
		case <-time.After(delay):
			delay *= 2
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	return err
}
```

Tested with the real clock:

```go title="slow/slow_test.go"
package slow

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestDoBackoffReal(t *testing.T) {
	start := time.Now()
	err := Do(t.Context(), 4, time.Second, func(context.Context) error { return errors.New("boom") })
	t.Logf("err=%v after %v", err, time.Since(start).Round(time.Second))
}
```

```bash
go test -v ./slow
```

```text
    slow_test.go:13: err=boom after 7s
--- PASS: TestDoBackoffReal (7.00s)
PASS
ok  	example.com/synctest-demo/slow	7.420s
```

Seven seconds to check one loop. A real suite has dozens of these, so people shorten the delays or skip the tests.

## synctest.Test: a bubble with a fake clock

`synctest.Test(t, f)` runs `f` in a new bubble. Inside the bubble:

- every goroutine started by `f` belongs to the bubble;
- `time.Now`, `time.Sleep`, timers, tickers and `context` deadlines use a **fake clock**, which starts at midnight, 1 January 2000 UTC;
- the clock moves only when every goroutine in the bubble is **durably blocked**, and then it jumps straight to the next timer. Computation takes no fake time.

```go title="retry_test.go"
package retry

import (
	"context"
	"errors"
	"testing"
	"testing/synctest"
	"time"
)

var errBoom = errors.New("boom")

func TestDoBackoff(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		start := time.Now()
		calls := 0
		err := Do(t.Context(), 4, time.Second, func(context.Context) error {
			calls++
			return errBoom
		})

		if !errors.Is(err, errBoom) {
			t.Fatalf("err = %v, want %v", err, errBoom)
		}
		if calls != 4 {
			t.Errorf("calls = %d, want 4", calls)
		}
		// 1s + 2s + 4s of waiting, on the bubble's fake clock.
		if got := time.Since(start); got != 7*time.Second {
			t.Errorf("elapsed = %v, want 7s", got)
		}
	})
}

func TestDoCancelled(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		ctx, cancel := context.WithCancel(t.Context())
		done := make(chan error)
		go func() {
			done <- Do(ctx, 5, time.Hour, func(context.Context) error { return errBoom })
		}()

		synctest.Wait() // Do is now waiting out its first delay
		cancel()
		if err := <-done; !errors.Is(err, context.Canceled) {
			t.Errorf("err = %v, want context.Canceled", err)
		}
	})
}
```

```bash
go test -v .
```

```text
--- PASS: TestDoBackoff (0.00s)
--- PASS: TestDoCancelled (0.00s)
PASS
ok  	example.com/synctest-demo	0.395s
```

(The run also contains the other tests of this stop; `=== RUN` lines are left out.) `TestDoBackoff` spends seven seconds of fake time in a few microseconds of real time, and asserts the elapsed time exactly: `time.Since(start) == 7*time.Second`. With a real clock that assertion is impossible, because scheduling adds jitter. In the bubble no jitter exists, so you can test "waits 1 s, then 2 s, then 4 s" with `==`.

## How it works

**Durably blocked.** A goroutine is durably blocked when only another goroutine *in the bubble* can wake it. These count: a send or receive on a channel made inside the bubble, a `select` whose cases are all such channels, `time.Sleep`, `sync.Cond.Wait`, and `sync.WaitGroup.Wait` when `Add` was called inside the bubble. These do not, because something outside the program's control can wake them: network and file I/O, system calls, cgo calls, locking a `sync.Mutex`, and channels created outside the bubble. A goroutine stuck on any of those stops the clock from advancing.

**Time advances in jumps.** When all goroutines are durably blocked, the runtime sets the clock to the earliest pending timer and wakes whoever waits on it. In `TestDoBackoff`, `Do` blocks in `select` on `time.After(1s)`; the clock jumps one second, `Do` retries, blocks on `time.After(2s)`, the clock jumps two more, and so on. If no timer exists, nothing can ever happen, and the test fails:

```go title="dead/dead_test.go"
package dead

import (
	"testing"
	"testing/synctest"
)

func TestDeadlock(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		ch := make(chan int)
		<-ch // nothing can ever send: every goroutine in the bubble is blocked
	})
}
```

```text
--- FAIL: TestDeadlock (0.00s)
panic: deadlock: all goroutines in bubble are blocked [recovered, repanicked]

goroutine 7 [running]:
...
testing/synctest.Test(0x22bd2d618400, 0x7ff7799e38b8)
	.../testing/synctest/synctest.go:291 +0x99
example.com/synctest-demo/dead.TestDeadlock(0x22bd2d618400?)
	.../dead/dead_test.go:9 +0x1a
```

That is a feature: a goroutine leak or a missing send inside the bubble becomes an immediate, located failure instead of a test that hangs for ten minutes. It also means `Test` waits for **every** goroutine in the bubble to exit before it returns, so a leaked goroutine is caught ([[goroutine-leaks]]).

**The bubble starts at a known time.**

```go title="clock_test.go"
package retry

import (
	"sync"
	"testing"
	"testing/synctest"
	"time"
)

func TestBubbleClock(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		t.Log("bubble starts at", time.Now().UTC())

		tick := time.NewTicker(time.Minute)
		defer tick.Stop()
		for range 3 {
			<-tick.C
		}
		t.Log("three ticks later", time.Now().UTC())
	})
}

func TestSleepWaits(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		var (
			mu   sync.Mutex
			done bool
		)
		go func() {
			time.Sleep(10 * time.Second)
			mu.Lock()
			done = true
			mu.Unlock()
		}()

		synctest.Sleep(10 * time.Second) // Go 1.27: time.Sleep, then synctest.Wait
		mu.Lock()
		defer mu.Unlock()
		if !done {
			t.Error("worker had not finished after Sleep returned")
		}
	})
}
```

```text
    clock_test.go:12: bubble starts at 2000-01-01 00:00:00 +0000 UTC
    clock_test.go:19: three ticks later 2000-01-01 00:03:00 +0000 UTC
--- PASS: TestBubbleClock (0.00s)
--- PASS: TestSleepWaits (0.00s)
```

Three minute-long ticks passed instantly, and exactly three minutes of fake time elapsed. (`time.Now()` prints in the local zone by default, so the example calls `.UTC()`; the value is the same instant.)

**The `t` you receive is restricted.** The `*testing.T` passed to `f` cannot call `t.Run`, `t.Parallel` or `t.Deadline`. A bubble is one test, so put `synctest.Test` *inside* a subtest rather than the other way round:

```go
t.Run("backoff", func(t *testing.T) {
	synctest.Test(t, func(t *testing.T) { /* ... */ })
})
```

`t.Cleanup` functions registered inside the bubble run inside it, before `Test` returns, so a cleanup may wait on bubble goroutines.

## synctest.Wait: let the others settle

`synctest.Wait()` blocks until every other goroutine in the bubble is durably blocked. Use it when the test needs to look at the state *after* background goroutines have done everything they can, without sleeping and guessing. `TestDoCancelled` starts `Do` in a goroutine, calls `Wait` so that `Do` is certainly inside its first one-hour delay, then cancels and checks that `Do` returns `context.Canceled`. Without `Wait`, the test might cancel before `Do` had even started waiting, and it would pass or fail depending on the scheduler.

## synctest.Sleep (Go 1.27)

Often the test wants to advance fake time by some amount and *then* look. `time.Sleep(d)` alone is not enough: other goroutines whose timers fire at the same instant may not have run yet. Go 1.27 adds `synctest.Sleep(d)`, which is `time.Sleep(d)` followed by `synctest.Wait()`.

`TestSleepWaits` (above) uses it: the worker sleeps ten seconds and then sets `done`. After `synctest.Sleep(10 * time.Second)` the worker has certainly finished, and the test can read `done`. Before 1.27 you wrote the two calls yourself.

Why it matters is easy to see by using plain `time.Sleep` instead:

```go title="hang2/h_test.go"
package hang2

import (
	"testing"
	"testing/synctest"
	"time"
)

func TestNoWait(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		n := 0
		go func() {
			time.Sleep(10 * time.Second)
			n++
		}()
		time.Sleep(10 * time.Second) // wakes at the same instant as the worker
		t.Log("n =", n)
	})
}
```

```bash
go test -race ./hang2
```

```text
==================
WARNING: DATA RACE
Write at 0x00c00000c2e8 by goroutine 11:
  example.com/synctest-demo/hang2.TestNoWait.func1.1()
      .../hang2/h_test.go:14 +0x4f

Previous read at 0x00c00000c2e8 by goroutine 10:
  example.com/synctest-demo/hang2.TestNoWait.func1()
      .../hang2/h_test.go:17 +0xf5
...
```

Both goroutines wake at the same fake instant, and nothing orders the worker's write before the test's read. Run without `-race` and the test sometimes prints `n = 0` and sometimes `n = 1`. Replace the test's `time.Sleep` with `synctest.Sleep` and it is correct and race-free: the sleep returns only once the worker is blocked or gone. See [[coverage-race]] for the race detector.

## Testing HTTP in a bubble

The in-memory server from [[httptest]] (`httptest.NewTestServer`, Go 1.27) works inside a bubble, so a test of a request timeout needs neither a real wait nor a real socket:

```go title="slowpage_test.go"
package retry

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"testing/synctest"
	"time"
)

func TestSlowPageTimesOut(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		srv := httptest.NewTestServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			select {
			case <-time.After(30 * time.Second): // a slow page
			case <-r.Context().Done():
				return
			}
			w.WriteHeader(http.StatusOK)
		}))

		ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
		defer cancel()
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://slow.test/page", nil)
		if err != nil {
			t.Fatal(err)
		}

		start := time.Now()
		_, err = srv.Client().Do(req)
		if !errors.Is(err, context.DeadlineExceeded) {
			t.Fatalf("err = %v, want a deadline error", err)
		}
		t.Logf("gave up after %v of fake time", time.Since(start))
	})
}
```

```text
    slowpage_test.go:36: gave up after 10s of fake time
--- PASS: TestSlowPageTimesOut (0.00s)
```

The handler would take 30 seconds; the request context allows 10. The client gives up after exactly ten fake seconds, in a few milliseconds of real time. Three details: the URL is written out because `srv.URL` is empty until the first request; the handler also watches `r.Context().Done()` so no goroutine outlives the test; and `NewTestServer` takes `t`, so the server closes itself.

## When to use it

| Situation | Use |
|---|---|
| Retries, backoff, timeouts, tickers, rate limiters | `synctest.Test`; assert exact fake time |
| "Has the background goroutine finished its work yet?" | `synctest.Wait` instead of `time.Sleep` |
| Advance time, then inspect state | `synctest.Sleep` (1.27) |
| Code that does real file or network I/O | Not a fit; use an in-memory fake (`httptest.NewTestServer`, `net.Pipe`) |
| Code that locks a `sync.Mutex` held across a wait | Restructure; the mutex is not durably blocking |

> [!WARNING]
> Real I/O inside a bubble does not advance the clock. A goroutine waiting on a real socket, file or system call is not durably blocked, so the runtime does not treat the bubble as idle: fake time stands still while real time passes. Symptom: a test that hangs or runs at real speed although it is inside `synctest.Test`. Fix: replace the I/O with an in-memory implementation, as above. Also never send on or close a channel created in the bubble from outside it; that panics.

> [!NOTE]
> `synctest.Test` is not a replacement for `-race`. The bubble makes timing deterministic; it does not make unsynchronised access safe. Run the same tests with `go test -race`, as the next stops do.

linkcheck has no retries, but its request timeout and rate limit are tested with `synctest.Test` in [[step-6-tests]]; the backoff you tested here is the idea behind the politeness delay of [[step-4-polite]] and the limiters in [[rate-limiting]].
