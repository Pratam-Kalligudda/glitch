---
title: Execution traces
done_when: "You can record an execution trace, mark parts of it with tasks and regions, and use go tool trace -pprof=sync to find where goroutines wait."
---
A CPU profile samples where the processor was busy. It cannot say why a program is slow while the processor is idle: goroutines waiting for a lock, a channel, the network, or for a processor to run on. An **execution trace** records events instead of samples: every time a goroutine starts, stops, blocks or is unblocked, with a timestamp, for a few seconds. It is the tool for latency, concurrency and scheduler questions: "why are my 8 workers not running in parallel?".

## Recording a trace, with regions

The program starts 8 goroutines. Each waits 20 ms on the "network", then updates shared state under a mutex, holding it for 10 ms. `runtime/trace` records the run, and **tasks**, **regions** and **logs** label the story:

- a **task** is a logical operation that may span goroutines (an HTTP request, a crawl);
- a **region** is a time interval inside one goroutine (`wait-network`, `update-shared`), nestable;
- a **log** is a timestamped message attached to a task.

```go title="main.go"
package main

import (
	"context"
	"fmt"
	"log"
	"os"
	"runtime/trace"
	"sync"
	"time"
)

var mu sync.Mutex

// fetch pretends to wait on the network, then updates shared state under a lock.
func fetch(ctx context.Context, id int) {
	defer trace.StartRegion(ctx, "fetch").End()

	trace.WithRegion(ctx, "wait-network", func() {
		time.Sleep(20 * time.Millisecond)
	})

	trace.WithRegion(ctx, "update-shared", func() {
		mu.Lock()
		defer mu.Unlock()
		time.Sleep(10 * time.Millisecond) // the critical section is too long
	})
	trace.Logf(ctx, "fetch", "worker %d done", id)
}

func main() {
	f, err := os.Create("trace.out")
	if err != nil {
		log.Fatal(err)
	}
	defer f.Close()
	if err := trace.Start(f); err != nil {
		log.Fatal(err)
	}
	defer trace.Stop()

	ctx, task := trace.NewTask(context.Background(), "crawl")
	var wg sync.WaitGroup
	for id := range 8 {
		wg.Go(func() { fetch(ctx, id) })
	}
	wg.Wait()
	task.End()
	fmt.Println("done")
}
```

```bash
go build -o tr .
./tr
```

```text
done
```

The program writes `trace.out`. `trace.Start(w)` enables tracing and `trace.Stop()` flushes it. Tracing slows the program a little (events are recorded for everything the scheduler does) and produces large files for busy programs, so trace seconds, not hours. `wg.Go` starts a goroutine and counts it in one call ([[waitgroup]]).

## Reading it

```bash
go tool trace trace.out
```

This starts a local web server and opens a browser page with these views, all built from the same file:

| View | Shows |
|---|---|
| View trace by proc | a timeline per processor (`P`): which goroutine ran when, garbage collection phases, and your regions |
| Goroutine analysis | per goroutine group: how long it ran, and how long it waited on sync, network, syscalls and the scheduler |
| User-defined tasks and regions | your `NewTask` and `StartRegion` labels, with durations |
| Network, Synchronization, Syscall, Scheduler latency profiles | the pprof-like profiles below |

The timeline viewer comes from the Chrome project and works in Chromium-based browsers. Without a browser, `go tool trace` can still produce profiles from the trace. `-pprof=sync` shows where goroutines blocked on synchronisation (mutexes, channels, wait groups), and the output opens in `go tool pprof` like the profiles in [[pprof-cpu]]:

```bash
go tool trace -pprof=sync trace.out > sync.pprof
go tool pprof -top -nodecount=6 sync.pprof
```

```text
Type: delay
Showing nodes accounting for 553.15ms, 100% of 553.15ms total
Showing top 6 nodes out of 11
      flat  flat%   sum%        cum   cum%
  328.22ms 59.34% 59.34%   328.22ms 59.34%  sync.(*Mutex).Lock
  116.15ms 21.00% 80.33%   116.15ms 21.00%  sync.(*WaitGroup).Wait
  108.78ms 19.67%   100%   108.78ms 19.67%  runtime.chanrecv1
         0     0%   100%   328.22ms 59.34%  main.fetch
         0     0%   100%   328.22ms 59.34%  main.fetch.func2
         0     0%   100%   116.15ms 21.00%  main.main
```

The numbers are total time goroutines spent blocked, summed over all goroutines. Of 553 ms of blocking, 328 ms is `sync.(*Mutex).Lock`, reached through `main.fetch.func2`, the closure of the `update-shared` region. `-list` pins the line:

```bash
go tool pprof -list 'main.fetch.func2' sync.pprof
```

```text
Total: 553.15ms
ROUTINE ======================== main.fetch.func2 in .../trace/main.go
         0   328.22ms (flat, cum) 59.34% of Total
         .          .     19:	trace.WithRegion(ctx, "wait-network", func() {
         .          .     20:		time.Sleep(20 * time.Millisecond)
         .          .     21:	})
         .          .     22:
         .          .     23:	trace.WithRegion(ctx, "update-shared", func() {
         .   328.22ms     24:		mu.Lock()
         .          .     25:		defer mu.Unlock()
         .          .     26:		time.Sleep(10 * time.Millisecond) // the critical section is too long
         .          .     27:	})
         .          .     28:	trace.Logf(ctx, "fetch", "worker %d done", id)
         .          .     29:}
```

(The first output line, `Main binary filename not available.`, is printed by `go tool pprof` for a trace-derived profile and can be ignored. Nothing here uses CPU, it is all waiting, so a CPU profile shows this program as nearly idle.)

The cause is in the code: eight goroutines contend for one mutex whose critical section includes a 10 ms `Sleep`. They finish one after another, so the last waits about 70 ms. The cure is to hold the lock only for the update itself, not for the slow work ([[mutexes]]).

The raw event stream shows the labels you added. `go tool trace -d=parsed trace.out` prints one line per event; filtered to the tasks, regions and logs of the run (the times removed):

```text
M=4272 P=0 G=1 TaskBegin ID=1 Parent=18446744073709551615 Type="crawl"
M=18816 P=0 G=13 RegionBegin Task=1 Type="update-shared"
M=18816 P=0 G=18 RegionBegin Task=1 Type="update-shared"
M=18816 P=0 G=13 RegionEnd Task=1 Type="update-shared"
M=18816 P=0 G=13 Log Task=1 Category="fetch" Message="worker 3 done"
M=28204 P=11 G=18 RegionEnd Task=1 Type="update-shared"
```

`G` is the goroutine, `P` the processor and `M` the operating-system thread. Several goroutines enter `update-shared` early, and they leave one at a time; a graphical view of this timeline shows a staircase of regions. Those IDs and addresses differ on every run.

## How it works

**What a trace contains.** The runtime emits an event for every goroutine state change (created, runnable, running, blocked on what, unblocked), for garbage collection phases, for syscalls and for processor activity. `go tool trace` reconstructs from them, for each goroutine, how its time divides: running, runnable but waiting for a processor (**scheduler latency**), blocked on synchronisation, blocked on the network, or in a syscall. The profile types `-pprof=net`, `sync`, `syscall` and `sched` aggregate these by call stack.

**Profile versus trace.**

| | CPU profile | Execution trace |
|---|---|---|
| Records | sampled stacks, 100 per second | every scheduling event |
| Finds | functions that use CPU | waiting, serialisation, idle processors, bad parallelism, long GC pauses |
| Cost | very low; fine in production | higher; use for seconds |
| Misses | anything not on a CPU | per-line CPU detail |

**Ways to get one.** `trace.Start` as above; `go test -trace=trace.out` for a test or benchmark; `net/http/pprof` serves `/debug/pprof/trace?seconds=5` for a running server. Go 1.25 added `trace.FlightRecorder`, which keeps a rolling window of the most recent trace in memory so a program can save "the last few seconds" only when something goes wrong, such as a request exceeding its deadline.

**Labels cost almost nothing when tracing is off.** `trace.WithRegion` and `trace.Logf` do nothing unless a trace is running, so they can stay in production code on the paths you care about, and they make the timeline readable: without them you see goroutine numbers, with them you see "fetch" and "update-shared".

> [!WARNING]
> Opening a trace and getting lost is the usual experience. Symptom: a timeline of thousands of coloured slices and no idea what to look at. Fix: begin with a question, not the picture. "Why is it not using all cores?" Look for processors with gaps (idle `P`s). "What is slow in this request?" Put a task around it and read the regions. "Is the GC the problem?" Look at the GC rows in the timeline. And start from the profile views (`-pprof=sync`, goroutine analysis), which summarise, before the raw timeline.

> [!NOTE]
> The scheduler view explains what you saw in [[goroutines]]: goroutines are scheduled onto `GOMAXPROCS` processors; a goroutine runnable but not running has scheduler latency. If `-pprof=sched` shows large waits while processors in the timeline are all busy, the program is CPU-bound and needs less work, not more goroutines. If processors are idle while goroutines wait, something is serialising them: a lock like this one, a channel with one reader, or a slow downstream call.

linkcheck's worker pool ([[step-3-concurrent]]) is a good subject for a trace: with the per-host rate limit in [[step-4-polite]] you can see workers blocking. [[step-9-profile]] measures the crawl with profiles instead.
