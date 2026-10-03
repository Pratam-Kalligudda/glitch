---
title: Goroutine leaks
done_when: "`go run ./leak` reports `goroutineleak profile: total 12`, and `go run ./fixed` reports `total 0`."
---
A goroutine leak is a goroutine that will never finish: it is blocked on a channel, a
mutex or a condition that nothing will ever release. Go has no way to kill it, and the
garbage collector does not free it, because a goroutine's stack is a root: everything it
references stays alive too. One leak per request is invisible in a test and fatal in a
server that runs for a week. Memory and the goroutine count climb steadily until the
process is killed.

The runtime only notices when **every** goroutine is stuck ([[channels]] shows that
`all goroutines are asleep` error). A leak in a program that is otherwise working is
silent. Since Go 1.27 the runtime can find many of them for you with the
`goroutineleak` profile.

## The classic leak: an early return

```go title="leak/main.go"
package main

import (
	"errors"
	"fmt"
	"os"
	"runtime"
	"runtime/pprof"
	"time"
)

type result struct {
	status int
	err    error
}

func check(url string) (int, error) {
	if url == "/broken" {
		return 0, errors.New("connection refused") // fails fast
	}
	time.Sleep(10 * time.Millisecond) // healthy pages take a while
	return 200, nil
}

// checkAll returns at the first error. Its remaining senders leak.
func checkAll(urls []string) ([]int, error) {
	ch := make(chan result) // unbuffered
	for _, u := range urls {
		go func() {
			s, err := check(u)
			ch <- result{s, err} // blocks forever once checkAll has returned
		}()
	}
	var statuses []int
	for range urls {
		r := <-ch
		if r.err != nil {
			return nil, r.err // early return: nobody receives the rest
		}
		statuses = append(statuses, r.status)
	}
	return statuses, nil
}

func main() {
	urls := []string{"/", "/broken", "/a", "/b", "/c"}
	for range 3 {
		_, err := checkAll(urls)
		fmt.Println("checkAll:", err)
	}
	time.Sleep(50 * time.Millisecond) // let the senders reach their send
	fmt.Println("goroutines:", runtime.NumGoroutine())

	pprof.Lookup("goroutineleak").WriteTo(os.Stdout, 1)
}
```

```bash
go run ./leak
```

```text
checkAll: connection refused
checkAll: connection refused
checkAll: connection refused
goroutines: 13
goroutineleak profile: total 12
12 @ 0x7ff6f6bfc52a 0x7ff6f6b90f5c 0x7ff6f6b90b57 0x7ff6f6c68245 0x7ff6f6c02601
#	0x7ff6f6c68244	main.checkAll.func1+0xa4	.../goroutine-leaks/leak/main.go:31
```

Addresses differ between runs and the path is shortened. Each call to `checkAll` gets
the `/broken` error first, returns, and leaves four goroutines blocked on `ch <- ...`.
Three calls leak twelve. The function's result is correct, so every test of it passes.

## How the leak profile works

`pprof.Lookup("goroutineleak")` returns the leak profile, one of the profiles
predefined by `runtime/pprof` next to `goroutine`, `heap` and the others. Writing it
first runs a garbage collection with leak detection turned on, then lists the goroutines
found to be leaked, grouped by stack. With `debug=1` you get the text form above: a count,
then the stack where those goroutines are blocked. Line 31 is the send.

The detection uses reachability, the same idea the garbage collector uses for memory. A
goroutine blocked on a channel can only be woken by some other goroutine that can reach
that channel. The runtime starts from every goroutine that can run and marks everything
they can reach, and everything that goroutines they could unblock can reach. A blocked
goroutine whose channel (or mutex, or `sync.Cond`) was never marked can never wake up: it
is leaked. Here, once `checkAll` returned, nothing but the four blocked senders held a
reference to `ch`.

Passing `debug=2` instead of `1` prints every goroutine in the format of an unrecovered
panic, and marks the leaked ones (this run used a copy of the program in `dbg2/`):

```text
goroutine 7 [chan send (leaked)]:
main.checkAll.func1()
	.../goroutine-leaks/dbg2/main.go:31 +0xa5
created by main.checkAll in goroutine 1
	.../goroutine-leaks/dbg2/main.go:29 +0x5f
```

The `created by` line points at the `go` statement, which is usually where the fix goes.

> [!NOTE]
> The `goroutineleak` profile arrived in Go 1.26 as an experiment, enabled by building
> with `GOEXPERIMENT=goroutineleakprofile`. Go 1.27 made it generally available and
> deleted that experiment setting, so with Go 1.27 it is always there. The release notes
> say it costs nothing at run time until a profile is actually collected.

### In a running server

Importing `net/http/pprof` for its side effects registers `/debug/pprof/` handlers on
`http.DefaultServeMux`, and since Go 1.27 the leak profile is one of them:

```go title="server/main.go"
package main

import (
	"log"
	"net/http"
	_ "net/http/pprof" // registers /debug/pprof/ handlers on http.DefaultServeMux
)

// leakOne starts a goroutine that waits on a channel nobody else can reach.
func leakOne() {
	ch := make(chan int)
	go func() {
		<-ch
	}()
}

func main() {
	http.HandleFunc("/leak", func(w http.ResponseWriter, r *http.Request) {
		leakOne()
		w.Write([]byte("leaked one goroutine\n"))
	})
	log.Fatal(http.ListenAndServe("localhost:6060", nil))
}
```

Run it, request `/leak` three times, then fetch the profile:

```bash
go run ./server &
curl localhost:6060/leak
curl localhost:6060/leak
curl localhost:6060/leak
curl "localhost:6060/debug/pprof/goroutineleak?debug=1"
```

```text
leaked one goroutine
leaked one goroutine
leaked one goroutine
goroutineleak profile: total 3
3 @ 0x7ff76f90798a 0x7ff76f895a6e 0x7ff76f8955b2 0x7ff76fb02259 0x7ff76f90e8e1
#	0x7ff76fb02258	main.leakOne.func1+0x18	.../goroutine-leaks/server/main.go:13
```

Without `?debug=1` the endpoint returns the binary profile format, which
`go tool pprof` reads ([[pprof-cpu]] covers the tool). Only expose `/debug/pprof/` on a
private address: it reveals your code's structure and lets anyone trigger extra
garbage collections.

### What it cannot see

The detector is conservative. If the channel a goroutine waits on is still reachable
from a global variable, or from a local variable of a goroutine that can still run, it
assumes someone might use it, and does not report the goroutine:

```go title="global/main.go"
package main

import (
	"fmt"
	"os"
	"runtime"
	"runtime/pprof"
	"time"
)

var jobs = make(chan string) // global: always reachable

func main() {
	go func() {
		for j := range jobs { // nobody ever sends or closes: stuck forever
			fmt.Println(j)
		}
	}()
	time.Sleep(10 * time.Millisecond)
	fmt.Println("goroutines:", runtime.NumGoroutine())
	pprof.Lookup("goroutineleak").WriteTo(os.Stdout, 1)
}
```

```text
goroutines: 2
goroutineleak profile: total 0
```

The goroutine is stuck forever, yet the profile is empty. So a clean leak profile is good
evidence, not proof. Two cheaper signals complement it: `runtime.NumGoroutine()` exported
as a metric (a count that only ever goes up is a leak), and the ordinary `goroutine`
profile, which lists every goroutine whatever its state.

## Fixing the leak

Every goroutine needs a guaranteed way to finish. For senders, that means one of: a
receiver that always drains the channel, a buffer large enough that no send can block,
or a `select` with a cancellation case. This version uses the last two:

```go title="fixed/main.go"
package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"runtime"
	"runtime/pprof"
	"time"
)

type result struct {
	status int
	err    error
}

func check(ctx context.Context, url string) (int, error) {
	if url == "/broken" {
		return 0, errors.New("connection refused")
	}
	select {
	case <-time.After(10 * time.Millisecond):
		return 200, nil
	case <-ctx.Done():
		return 0, ctx.Err()
	}
}

// checkAll still returns at the first error, but leaks nothing.
func checkAll(ctx context.Context, urls []string) ([]int, error) {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel() // stops the remaining checks when we return early

	ch := make(chan result, len(urls)) // room for every sender: no send can block
	for _, u := range urls {
		go func() {
			s, err := check(ctx, u)
			ch <- result{s, err}
		}()
	}
	var statuses []int
	for range urls {
		r := <-ch
		if r.err != nil {
			return nil, r.err
		}
		statuses = append(statuses, r.status)
	}
	return statuses, nil
}

func main() {
	urls := []string{"/", "/broken", "/a", "/b", "/c"}
	for range 3 {
		_, err := checkAll(context.Background(), urls)
		fmt.Println("checkAll:", err)
	}
	time.Sleep(50 * time.Millisecond)
	fmt.Println("goroutines:", runtime.NumGoroutine())
	pprof.Lookup("goroutineleak").WriteTo(os.Stdout, 1)
}
```

```bash
go run ./fixed
```

```text
checkAll: connection refused
checkAll: connection refused
checkAll: connection refused
goroutines: 1
goroutineleak profile: total 0
```

The buffer of `len(urls)` means every sender can complete its send even if nobody ever
receives; the channel and its unread values are then garbage-collected with the
goroutines gone. `cancel()` on return makes the remaining checks stop at once instead of
finishing work nobody will read. The buffer alone fixes the leak; the context also saves
the wasted work. `errgroup` packages the same idea ([[errgroup]]).

| Leak cause | Fix |
|---|---|
| Sender blocked because the receiver returned early | Buffer for every sender, or `select` on `<-ctx.Done()` when sending |
| Receiver ranging over a channel nobody closes | The sender (only the sender) closes it when done ([[channels]]) |
| Worker waiting on a job channel forever | Close the job channel, or select on cancellation ([[worker-pools]]) |
| `time.Ticker` loop with no exit case | Add a `<-ctx.Done()` case and `defer t.Stop()` ([[select]]) |
| Goroutine waiting on a mutex held by a stuck goroutine | Fix the stuck one; never block while holding a lock ([[mutexes]]) |
| Pipeline whose sink stops early | Cancel the context the stages select on ([[pipelines]]) |

> [!WARNING]
> Starting a goroutine without knowing how it ends. Symptom: `NumGoroutine()` and memory
> grow in proportion to traffic, and a goroutine profile shows thousands of goroutines
> parked at the same line, usually a channel send or receive. Fix: for every `go`
> statement, name the event that makes it return (a closed channel, a cancelled context,
> a buffer that guarantees its send) and write that into the code. Then check: run the
> `goroutineleak` profile after your tests or load tests and expect `total 0`.

Tests can catch leaks before production: `synctest.Test` waits for every goroutine it
started and fails the test if they are left deadlocked ([[synctest]]). linkcheck adds a
goroutine leak check after a crawl in [[step-9-profile]].
