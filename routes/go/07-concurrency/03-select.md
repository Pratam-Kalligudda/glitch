---
title: select and timeouts
---
`select` waits on several channel operations at once and runs the first one that can
proceed. It is how a goroutine says "whichever happens first": a result or a timeout, a
new job or a stop signal. Without it, a goroutine blocked on one channel cannot react to
anything else.

A `select` looks like a `switch` whose cases are sends or receives:

```go title="timeout/main.go"
package main

import (
	"fmt"
	"time"
)

// fetch pretends to download a page and takes d to do it.
func fetch(d time.Duration) <-chan string {
	ch := make(chan string, 1) // buffered: fetch can finish even if nobody waits
	go func() {
		time.Sleep(d)
		ch <- fmt.Sprintf("page after %v", d)
	}()
	return ch
}

func get(d, limit time.Duration) {
	select {
	case page := <-fetch(d):
		fmt.Println("ok:", page)
	case <-time.After(limit):
		fmt.Println("timeout after", limit)
	}
}

func main() {
	get(10*time.Millisecond, 100*time.Millisecond)
	get(200*time.Millisecond, 100*time.Millisecond)
}
```

```bash
go run ./timeout
```

```text
ok: page after 10ms
timeout after 100ms
```

## How select chooses

1. Every channel expression and every value to send is evaluated once, in source order,
   when the `select` starts. Here that means `fetch(d)` starts its goroutine and
   `time.After(limit)` creates its timer before `select` waits on either.
2. If one or more cases can proceed now, `select` picks one of them **uniformly at
   random**. Source order gives no priority.
3. If none can proceed and there is a `default` case, `default` runs at once.
4. Otherwise the goroutine blocks until one case can proceed, then runs it.

`time.After(d)` returns a channel that receives the current time once `d` has passed. In
the second call the timer fires first, `select` takes that case, and `get` returns. The
`fetch` goroutine still finishes 100 ms later; its channel has a buffer of one, so its
send succeeds even though nobody receives, and the goroutine exits. With an unbuffered
channel it would block forever: a leak, the subject of [[goroutine-leaks]].

The random choice is real. When both cases are always ready, each wins about half the
time:

```go title="fair/main.go"
package main

import "fmt"

func main() {
	a := make(chan int, 1000)
	b := make(chan int, 1000)
	for i := range 1000 {
		a <- i
		b <- i
	}

	counts := map[string]int{}
	for range 1000 {
		select {
		case <-a:
			counts["a"]++
		case <-b:
			counts["b"]++
		}
	}
	fmt.Println(counts)
}
```

```text
map[a:506 b:494]
```

The exact split changes on every run. Randomness prevents one busy channel from starving
another. It also means you cannot rely on case order for priority: if a stop signal and a
job are both ready, `select` may pick the job. When stopping must win, check the stop
channel in its own non-blocking `select` before the main one.

## default: try without blocking

A `select` with a `default` case never blocks. That gives you a non-blocking send (drop
the value if nobody can take it) and a non-blocking receive (poll):

```go title="nonblock/main.go"
package main

import "fmt"

func main() {
	events := make(chan string, 2)
	for _, e := range []string{"start", "page", "page", "done"} {
		select {
		case events <- e:
			fmt.Println("queued", e)
		default:
			fmt.Println("dropped", e, "(buffer full)")
		}
	}

	for {
		select {
		case e := <-events:
			fmt.Println("handled", e)
		default:
			fmt.Println("nothing left")
			return
		}
	}
}
```

```text
queued start
queued page
dropped page (buffer full)
dropped done (buffer full)
handled start
handled page
nothing left
```

Dropping is right for things like progress updates, where a missed one does not matter.
Do not put `default` in a `for`/`select` loop that has nothing else to wait for: the loop
spins at 100% CPU instead of blocking.

## Turning a case off with a nil channel

An operation on a nil channel blocks forever ([[channels]]), so a `select` case on a nil
channel is never chosen. Setting a channel variable to `nil` switches its case off. This
merges two channels until both are closed:

```go title="merge/main.go"
package main

import "fmt"

func numbers(prefix string, n int) <-chan string {
	ch := make(chan string)
	go func() {
		defer close(ch)
		for i := range n {
			ch <- fmt.Sprint(prefix, i)
		}
	}()
	return ch
}

func main() {
	a, b := numbers("a", 2), numbers("b", 3)
	for a != nil || b != nil {
		select {
		case v, ok := <-a:
			if !ok {
				a = nil // closed: a nil channel is never ready, so this case is off
				continue
			}
			fmt.Println(v)
		case v, ok := <-b:
			if !ok {
				b = nil
				continue
			}
			fmt.Println(v)
		}
	}
	fmt.Println("both closed")
}
```

```text
b0
b1
a0
b2
a1
both closed
```

The interleaving of `a` and `b` lines varies between runs; each channel's own values stay
in order. Without `a = nil`, a closed `a` is always ready (it returns the zero value at
once), so the loop would spin on it.

## Timers and tickers in a loop

A `for` loop around a `select` is the standard shape of a long-running goroutine. A
`time.Ticker` delivers a value on its channel `C` at a fixed interval:

```go title="ticker/main.go"
package main

import (
	"fmt"
	"time"
)

func main() {
	tick := time.NewTicker(30 * time.Millisecond)
	defer tick.Stop()
	stop := time.After(100 * time.Millisecond)

	for {
		select {
		case t := <-tick.C:
			fmt.Println("tick", t.Format("05.000"))
		case <-stop:
			fmt.Println("stop")
			return
		}
	}
}
```

```text
tick 40.781
tick 40.811
tick 40.841
stop
```

The seconds-and-milliseconds stamps differ on every run; the gap between them is 30 ms.

Since Go 1.23 (for modules whose `go.mod` says `go 1.23` or later), an unreferenced
`Timer` or `Ticker` is garbage-collected even if you never call `Stop`, and timer channels
are unbuffered, so after `Stop` or `Reset` returns no stale value is delivered. Go 1.27
removed the `asynctimerchan` GODEBUG setting that could restore the old behaviour, so this
now always holds. Calling `Stop` is still good practice: it ends the ticker's work at
once instead of whenever the collector runs.

A common mistake hides in this shape. `time.After` inside a `for`/`select` loop creates a
new timer on every iteration, so the timeout restarts each time any other case fires:

```go title="idleloop/main.go"
package main

import (
	"fmt"
	"time"
)

func main() {
	msgs := make(chan int)
	go func() {
		for i := range 5 {
			time.Sleep(40 * time.Millisecond)
			msgs <- i
		}
	}()

	start := time.Now()
	for {
		select {
		case m := <-msgs:
			fmt.Println("message", m)
		case <-time.After(100 * time.Millisecond): // new timer every iteration
			fmt.Println("timed out after", time.Since(start).Round(10*time.Millisecond))
			return
		}
	}
}
```

```text
message 0
message 1
message 2
message 3
message 4
timed out after 300ms
```

The 100 ms timeout only fired once the sender stopped, 300 ms in. That is an idle timeout
("100 ms with no message"), which is sometimes what you want. For a total budget, create
the channel once, before the loop:

```go title="idle/main.go"
package main

import (
	"fmt"
	"time"
)

func main() {
	msgs := make(chan int)
	go func() {
		for i := range 5 {
			time.Sleep(40 * time.Millisecond)
			msgs <- i
		}
	}()

	deadline := time.After(100 * time.Millisecond) // created once: a total budget
	for {
		select {
		case m := <-msgs:
			fmt.Println("message", m)
		case <-deadline:
			fmt.Println("total budget used up")
			return
		}
	}
}
```

```text
message 0
message 1
total budget used up
```

The sender goroutine is left blocked on its third send here because the program ends;
in a long-running program it would leak, which [[goroutine-leaks]] fixes with
cancellation.

> [!WARNING]
> `time.After(d)` written inside a loop's `select` means "d since the last event", not
> "d in total". Symptom: a timeout that never fires while traffic keeps arriving, so a
> slow trickle of messages holds the loop open forever. Fix: create the timer or the
> `time.After` channel once before the loop, or use a context with a deadline
> ([[context]]) when the budget crosses function calls.

linkcheck's crawl loop is a `for`/`select` that waits on results and on cancellation at
the same time, in [[step-3-concurrent]].
