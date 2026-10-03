---
title: Goroutines and the scheduler
---
A goroutine is a function running independently of the code that started it. You start one
by putting `go` in front of a function call. The call returns at once; the function runs
concurrently with everything else. Goroutines are what make Go programs concurrent, and
they are cheap enough that a program can run hundreds of thousands of them.

Concurrency means several tasks are in progress at once and can make progress
independently. Parallelism means several tasks execute at the same instant on different CPU
cores. Goroutines give you concurrency; the runtime decides how much of it runs in
parallel.

## main does not wait

```go title="early/main.go"
package main

import "fmt"

func main() {
	for i := range 3 {
		go fmt.Println("goroutine", i)
	}
	fmt.Println("main returns")
}
```

```bash
go run ./early
```

```text
main returns
```

None of the three goroutines printed. A Go program ends when `main` returns, and it does
not wait for other goroutines: they are stopped mid-flight, with no deferred calls run and
no cleanup. The three goroutines were created, but `main` reached its last line before the
scheduler gave any of them a turn. On another run one of them might squeeze in a line
first; you cannot rely on either outcome.

Something has to make `main` wait. Go gives you two tools for that: a channel receive
([[channels]]) or a `sync.WaitGroup` ([[waitgroup]]). The rest of this stop uses a
`WaitGroup` with a one-line explanation; its own stop covers it fully.

## Arguments are evaluated when the go statement runs

`go f(x)` evaluates `f` and `x` in the current goroutine, immediately, and then runs the
call in a new goroutine. Only the call is deferred, exactly like `defer f(x)` in
[[defer]].

```go title="evalargs/main.go"
package main

import (
	"fmt"
	"sync"
)

func main() {
	var wg sync.WaitGroup
	name := "first"

	wg.Add(1)
	go func(n string) { // n is copied now, when the go statement runs
		defer wg.Done()
		fmt.Println("argument:", n)
	}(name)
	wg.Wait()

	name = "second"
	fmt.Println("variable:", name)
}
```

```bash
go run ./evalargs
```

```text
argument: first
variable: second
```

`wg.Add(1)` says one goroutine is outstanding, `wg.Done()` marks it finished, and
`wg.Wait()` blocks until the count is back to zero. The goroutine received its own copy of
`name`. A closure that reads `name` directly instead shares the variable with `main`; when
both sides touch it at the same time, that is a data race ([[memory-model]]). Since
Go 1.22 each loop iteration has its own loop variable ([[loop-variables]]), so
`go func() { use(i) }()` inside a `for` loop is safe; before 1.22 it was a classic bug.

## How cheap is a goroutine

```go title="cheap/main.go"
package main

import (
	"fmt"
	"runtime"
	"sync"
)

func main() {
	var before runtime.MemStats
	runtime.ReadMemStats(&before)

	const n = 100_000
	var started sync.WaitGroup
	release := make(chan struct{})
	started.Add(n)
	for range n {
		go func() {
			started.Done()
			<-release // park until main closes release
		}()
	}
	started.Wait()

	var after runtime.MemStats
	runtime.ReadMemStats(&after)
	fmt.Println("goroutines:", runtime.NumGoroutine())
	fmt.Println("GOMAXPROCS:", runtime.GOMAXPROCS(0))
	fmt.Printf("stack memory: %d MiB, about %d bytes each\n",
		(after.StackInuse-before.StackInuse)>>20,
		(after.StackInuse-before.StackInuse)/n)
	close(release)
}
```

```bash
go run ./cheap
```

```text
goroutines: 100001
GOMAXPROCS: 12
stack memory: 781 MiB, about 8192 bytes each
```

This run is on a 12-core Windows machine. Each goroutine parks on `<-release` (a channel
receive, covered in [[channels]]) so all 100,000 exist at once; `NumGoroutine` counts them
plus `main`.

A goroutine starts with a small stack that grows and shrinks as needed. The runtime's
minimum is 2 KiB; on Windows it adds 4 KiB of space reserved for system calls, which is
why this run shows 8 KiB. An operating system thread usually reserves a megabyte or more
of stack up front, so a hundred thousand threads would not fit where a hundred thousand
goroutines do. Creating a goroutine is a function call plus a small allocation, not a
system call.

## How the scheduler works

The Go runtime multiplexes goroutines onto operating system threads. Its model has three
parts:

| Name | What it is |
|---|---|
| G | A goroutine: a stack, an instruction pointer, and its state (running, runnable, waiting) |
| M | A machine: an operating system thread |
| P | A processor: the right to run Go code. Each P has a local queue of runnable Gs |

There are exactly `GOMAXPROCS` Ps. To run Go code, an M must hold a P. So `GOMAXPROCS` is
the number of goroutines that can execute Go code in parallel; the program may still have
more threads, for example threads blocked in system calls.

What happens when a goroutine runs:

1. `go f()` creates a G and puts it on the current P's run queue.
2. An M holding that P picks the G and runs it.
3. When the G blocks on a channel, a mutex, a timer or network I/O, the runtime parks it
   (the G waits off-CPU, costing no thread) and the M picks the next runnable G. Network
   I/O uses the netpoller, which wakes the G when the socket is ready.
4. When the G makes a blocking system call (a file read), the M blocks with it; the P is
   handed to another M so other goroutines keep running.
5. A P with an empty queue steals half the work from another P's queue, so load spreads
   across cores.
6. A goroutine that runs a long time without blocking is preempted (since Go 1.14,
   asynchronously, even in a tight loop with no function calls), so one busy goroutine
   cannot starve the others.

`GOMAXPROCS` defaults to the number of logical CPUs. Since Go 1.25, on Linux it also
respects a container's CPU limit (the cgroup CPU bandwidth limit, "CPU limit" in
Kubernetes), and the runtime updates it periodically if the available CPUs change. Setting
the `GOMAXPROCS` environment variable or calling `runtime.GOMAXPROCS(n)` turns both off.
`runtime.GOMAXPROCS(0)` reads the value without changing it.

## A panic in any goroutine ends the program

```go title="crash/main.go"
package main

import (
	"fmt"
	"time"
)

func worker(id int) {
	if id == 2 {
		var m map[string]int
		m["boom"] = 1 // assignment to a nil map panics
	}
	fmt.Println("worker", id, "done")
}

func main() {
	for i := range 3 {
		go worker(i)
	}
	time.Sleep(100 * time.Millisecond)
	fmt.Println("main done")
}
```

```bash
go run ./crash
```

```text
worker 1 done
panic: assignment to entry in nil map

goroutine 9 [running]:
main.worker(0x2)
	.../goroutines/crash/main.go:11 +0x37
created by main.main in goroutine 1
	.../goroutines/crash/main.go:18 +0x49
exit status 2
```

The file paths are shortened here; the goroutine number and which workers print first vary
between runs. `recover` only works in the goroutine that panicked ([[panic-recover]]):
`main` cannot catch a panic from a goroutine it started, and a panic that unwinds to the
top of any goroutine crashes the whole process. The trace names the goroutine that
panicked and the line in `main` that created it.

> [!WARNING]
> Waiting with `time.Sleep`, as `crash/main.go` does, is a guess. Symptom: output that is
> complete on your machine and truncated on a slower CI runner, or a program that is
> always 100 ms slower than it needs to be. Fix: wait for the goroutines explicitly with a
> `sync.WaitGroup` ([[waitgroup]]) or by receiving their results from a channel
> ([[channels]]).

> [!WARNING]
> Every goroutine you start needs a known way to finish. A goroutine blocked forever is a
> leak: its stack and everything it references stay in memory until the process exits.
> Before you write `go`, decide what will make that goroutine return. [[goroutine-leaks]]
> shows how to find the ones that do not.

The linkcheck capstone runs its page fetches in goroutines and shuts them down cleanly on
Ctrl-C in [[step-3-concurrent]].
