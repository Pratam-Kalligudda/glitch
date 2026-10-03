---
title: Channels
---
A channel is a typed pipe between goroutines: one goroutine sends a value in, another
receives it out. A channel does two jobs at once. It moves data, and it synchronises: a
receive cannot finish before the matching send, so whatever the sender did before sending
is visible to the receiver. That is why Go's advice is "do not communicate by sharing
memory; share memory by communicating".

You create a channel with `make`. `make(chan T)` makes an unbuffered channel;
`make(chan T, n)` makes a buffered one with room for `n` values. `ch <- v` sends,
`v := <-ch` receives, and `close(ch)` says no more values will be sent.

## A producer and a consumer

```go title="basic/main.go"
package main

import (
	"fmt"
	"strings"
)

// produce sends each word, then closes the channel to say "no more values".
func produce(words []string, out chan<- string) {
	for _, w := range words {
		out <- w
	}
	close(out)
}

// consume receives until the channel is closed and drained.
func consume(in <-chan string, done chan<- int) {
	n := 0
	for w := range in {
		fmt.Println("got", strings.ToUpper(w))
		n++
	}
	done <- n
}

func main() {
	words := make(chan string) // unbuffered
	done := make(chan int)

	go produce([]string{"alpha", "beta", "gamma"}, words)
	go consume(words, done)

	fmt.Println("received", <-done, "words")
}
```

```bash
go run ./basic
```

```text
got ALPHA
got BETA
got GAMMA
received 3 words
```

## How it works

**Unbuffered channels are a rendezvous.** A send on `words` blocks until `consume` is
ready to receive, and a receive blocks until `produce` sends. Each value is handed over
directly, with both goroutines meeting at that point. That is why the words come out in
order and why `main` can block on `<-done` to wait for the result: `main` is parked until
`consume` sends.

**Direction types limit what a function may do.** `chan<- string` is send-only and
`<-chan string` is receive-only. A bidirectional `chan string` converts to either
implicitly when you pass it. `produce` cannot receive from `out`, and `consume` cannot
close `in` (closing a receive-only channel is a compile error). Use direction types in
every function signature; they document who owns which end.

**`close` is a broadcast, not a value.** After `close(words)`, receivers first drain any
values still in the channel, then every receive returns at once with the zero value.
`for w := range in` receives until exactly that point and then ends the loop. Closing is
only needed when receivers must learn there is no more data, as `range` does. A channel
nobody closes is collected by the garbage collector like any other value once nothing
references it.

**Buffered channels decouple the two sides.** A send blocks only when the buffer is full,
and a receive blocks only when it is empty. `len(ch)` is the number of queued values,
`cap(ch)` the buffer size.

```go title="buffered/main.go"
package main

import "fmt"

func main() {
	ch := make(chan int, 3)
	ch <- 1
	ch <- 2
	fmt.Println("len", len(ch), "cap", cap(ch))

	close(ch)
	for range 4 {
		v, ok := <-ch
		fmt.Println(v, ok)
	}
}
```

```text
len 2 cap 3
1 true
2 true
0 false
0 false
```

`main` sent twice without any receiver because the buffer had room. The two-value receive
`v, ok := <-ch` tells a real value (`ok` is true) from the zero value of a closed, drained
channel (`ok` is false). Use it whenever `0` or `""` could be a legitimate value.

A buffer is not a performance switch. Pick its size for a reason: `1` so a sender can
leave without waiting for a receiver that may already be gone (you will see this in
[[goroutine-leaks]]), or `n` when you know exactly `n` values will be sent. A buffer that
only hides a slow consumer just delays the moment the sender blocks.

## Every operation, in every state

| Operation | nil channel | open channel | closed channel |
|---|---|---|---|
| `ch <- v` | blocks forever | blocks until a receiver or buffer space | panic: send on closed channel |
| `<-ch` | blocks forever | blocks until a value is available | buffered values, then zero value, `ok == false` |
| `close(ch)` | panic: close of nil channel | closes it | panic: close of closed channel |
| `len(ch)`, `cap(ch)` | 0 | queued values, buffer size | queued values, buffer size |

A nil channel is the zero value of a channel type: declared but never made. Blocking
forever sounds useless, but it lets you switch off a case in `select`; see [[select]].

## Deadlock

When every goroutine is blocked, nothing can ever wake any of them. The runtime detects
that case and stops the program:

```go title="deadlock/main.go"
package main

import "fmt"

func main() {
	ch := make(chan int)
	ch <- 1 // no receiver can ever run: main is the only goroutine
	fmt.Println(<-ch)
}
```

```bash
go run ./deadlock
```

```text
fatal error: all goroutines are asleep - deadlock!

goroutine 1 [chan send]:
main.main()
	.../channels/deadlock/main.go:7 +0x36
exit status 2
```

The send on an unbuffered channel waits for a receiver, and the only code that could
receive is the next line of the same goroutine. The trace shows the state of each
goroutine in brackets: `[chan send]` here, `[chan receive (nil chan)]` for a receive from a
nil channel. This detector only fires when **all** goroutines are blocked. If any other
goroutine is still alive (a timer, an HTTP server, a goroutine sleeping), a set of stuck
goroutines is not reported and simply hangs; [[goroutine-leaks]] covers finding those.

## Who closes the channel

The rule: **only the sender closes, and only when no other sender can still send.** A
send on a closed channel panics, and so does a second close:

```go title="sendclosed/main.go"
package main

import "fmt"

func main() {
	ch := make(chan int, 1)
	close(ch)
	fmt.Println("closed; receive gives", <-ch)
	ch <- 1
}
```

```text
closed; receive gives 0
panic: send on closed channel

goroutine 1 [running]:
main.main()
	.../channels/sendclosed/main.go:9 +0xbd
exit status 2
```

With one sender, the sender closes when it is done, as `produce` does. With several
senders, none of them knows when the others are finished, so none of them may close.
Count them with a `sync.WaitGroup` ([[waitgroup]]) and let one extra goroutine close the
channel after the count reaches zero:

```go title="fixed/main.go"
package main

import (
	"fmt"
	"sync"
)

func check(url string) string { return "checked " + url }

func main() {
	urls := []string{"a", "b", "c"}
	results := make(chan string)

	var wg sync.WaitGroup
	for _, url := range urls {
		wg.Add(1)
		go func() {
			defer wg.Done()
			results <- check(url) // senders only send
		}()
	}

	// One goroutine owns closing: after every sender is done.
	go func() {
		wg.Wait()
		close(results)
	}()

	for r := range results {
		fmt.Println(r)
	}
	fmt.Println("all results in")
}
```

```bash
go run ./fixed
```

```text
checked a
checked c
checked b
all results in
```

The order of the three lines changes from run to run: the goroutines finish in whatever
order the scheduler runs them. `wg.Wait()` runs in its own goroutine because `main` must
be free to receive; if `main` called `wg.Wait()` before the `range`, the senders would
block on the unbuffered channel forever and the program would deadlock.

> [!WARNING]
> Closing a shared channel from each sender (`results <- r; close(results)` inside every
> worker) is the most common channel bug. Symptom: `panic: send on closed channel` or
> `panic: close of closed channel`, often only under load, or a receiver that stops early
> because the first close ended its `range`. Fix: senders never close a channel they
> share; one owner closes it after `wg.Wait()`, as above. Receivers never close a channel
> to stop senders; use cancellation for that ([[context]]).

> [!NOTE]
> Channels are not the answer to every sharing problem. A counter or a cache read by many
> goroutines is simpler with a mutex ([[mutexes]]). Use channels to hand over ownership of
> data or to signal events; use a mutex to guard state that stays in one place.

linkcheck's workers send each checked link on a `finished` channel to the one goroutine
that runs the crawl, and that goroutine alone closes the `jobs` channel, in
[[step-3-concurrent]].
