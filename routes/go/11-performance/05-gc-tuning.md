---
title: The garbage collector, GOGC and GOMEMLIMIT
done_when: "You can read a gctrace line, explain how GOGC sets the heap goal, and choose GOMEMLIMIT for a container with the reasoning behind the value."
---
Go frees memory automatically with a **garbage collector** (GC). It finds the values the program can still reach, called the **live heap**, and reclaims everything else. Collecting takes CPU time. Memory that has not been collected yet takes space. Tuning the collector is choosing a point on that trade-off: more memory for less CPU, or less memory for more CPU. Go gives you two knobs, `GOGC` and `GOMEMLIMIT`, and a default that is right for most programs.

As of Go 1.26 the collector is the **Green Tea** collector, which scans small objects in groups for better memory locality and scales better across cores. The release notes expect a 10 to 40 percent reduction in GC overhead for programs that rely heavily on the collector. It needs no configuration. Building with `GOEXPERIMENT=nogreenteagc` selects the previous collector; the Go 1.26 notes say that switch is expected to be removed in Go 1.27, so use it only to compare in an emergency and report the problem if you need it.

## How a collection is scheduled: GOGC

The collector runs when the heap reaches a **goal** computed after each cycle:

```text
goal = live heap + (live heap + GC roots) * GOGC / 100
```

(From the Go GC guide. The **roots** are goroutine stacks and global variables, which the collector also has to scan.) `GOGC` defaults to 100. With a live heap of 64 MiB and negligible roots, the goal is about 128 MiB: the program can allocate another 64 MiB before the next collection starts. Doubling `GOGC` roughly doubles the extra memory and roughly halves the CPU spent collecting.

This program holds 64 MiB live and then allocates 400 000 short-lived 4 KiB buffers, about 1.6 GiB of garbage:

```go title="main.go"
package main

import (
	"fmt"
	"os"
	"runtime"
	"time"
)

var sink []byte

func main() {
	// A live heap of about 64 MiB that stays reachable for the whole run.
	live := make([][]byte, 64)
	for i := range live {
		live[i] = make([]byte, 1<<20)
	}

	start := time.Now()
	for i := 0; i < 400_000; i++ {
		sink = make([]byte, 4096) // garbage: dead after the next iteration
		sink[0] = byte(i)
	}
	elapsed := time.Since(start)

	var m runtime.MemStats
	runtime.ReadMemStats(&m)
	fmt.Printf("GOGC=%-4s GOMEMLIMIT=%-6s gc cycles=%5d  time=%-6v peak sys=%4d MiB\n",
		os.Getenv("GOGC"), os.Getenv("GOMEMLIMIT"), m.NumGC,
		elapsed.Round(10*time.Millisecond), m.Sys>>20)
	runtime.KeepAlive(live)
}
```

Run it with different settings. `GOGC=value ./gc` sets the variable for one command in a POSIX shell (in PowerShell: `$env:GOGC="50"; .\gc.exe`):

```bash
go build -o gc .
for g in 50 100 200 400 off; do GOGC=$g ./gc; done
```

```text
GOGC=50   GOMEMLIMIT=       gc cycles=   58  time=220ms  peak sys= 116 MiB
GOGC=100  GOMEMLIMIT=       gc cycles=   29  time=220ms  peak sys= 170 MiB
GOGC=200  GOMEMLIMIT=       gc cycles=   15  time=230ms  peak sys= 215 MiB
GOGC=400  GOMEMLIMIT=       gc cycles=    7  time=270ms  peak sys= 371 MiB
GOGC=off  GOMEMLIMIT=       gc cycles=    0  time=470ms  peak sys=1674 MiB
```

Read the first two numeric columns as a pair. Doubling `GOGC` halves the number of cycles (58, 29, 15, 7) and raises the peak memory the process asked the OS for (`Sys`). With the collector off the program used 1.6 GiB, the whole garbage volume, and was not even faster: a growing heap means constantly asking the OS for fresh memory. Timings are noisy on a desktop and the loop here barely uses the collector's CPU, so trust the cycle and memory columns; on a real program with a large live heap the CPU difference is the point.

`GOGC=off` disables collection altogether. It is almost always wrong, except together with a memory limit (below) or for a short-lived program that you know allocates little.

In code, `debug.SetGCPercent(n)` from `runtime/debug` changes the value and returns the old one.

## Reading a gctrace line

`GODEBUG=gctrace=1` makes the runtime print one line per collection to stderr:

```bash
GODEBUG=gctrace=1 ./gc 2>&1 | sed -n 5p
GODEBUG=gctrace=1 ./gc 2>&1 | sed -n 29p
```

```text
gc 5 @0.011s 0%: 0+0+0 ms clock, 0+0/0/0+0 ms cpu, 75->75->64 MB, 76 MB goal, 0 MB stacks, 0 MB globals, 12 P
gc 29 @0.195s 3%: 0+0+0 ms clock, 0+0/0/0+0 ms cpu, 127->128->64 MB, 130 MB goal, 0 MB stacks, 0 MB globals, 12 P
```

| Part | Meaning |
|---|---|
| `gc 29` | the 29th collection since start |
| `@0.195s` | seconds since the program started |
| `3%` | share of the program's CPU time spent on GC so far |
| `0+0+0 ms clock` | wall-clock time of the three phases: stop-the-world sweep termination, concurrent mark, stop-the-world mark termination |
| `0+0/0/0+0 ms cpu` | CPU time of the same phases, with assist, background and idle mark time split out |
| `127->128->64 MB` | heap size at the start of the collection, at its end, and **live** after it |
| `130 MB goal` | the target for the next cycle |
| `12 P` | processors in use |

The `127->128->64` part is the most useful. The last number, 64 MB, is the live heap: the 64 MiB the program holds. The goal (130 MB) is that live heap plus 100% of it, as the formula says. If the live number keeps climbing between lines the program is leaking ([[pprof-heap]]); if the first number is close to the goal at each line the collector is running often.

## A hard ceiling: GOMEMLIMIT

`GOGC` reasons about the heap relative to live data, so peak memory moves with the program. A container has a fixed size: exceed it and the kernel kills the process (out of memory). **`GOMEMLIMIT`** sets a **soft memory limit** for the whole Go runtime. When the total approaches the limit the collector runs more often than `GOGC` would ask, to stay below it. The value is a number of bytes with an optional suffix `B`, `KiB`, `MiB`, `GiB` or `TiB` (powers of two). `debug.SetMemoryLimit(n)` does the same from code.

```bash
GOGC=off GOMEMLIMIT=150MiB ./gc
GOGC=off GOMEMLIMIT=100MiB ./gc
GOGC=off GOMEMLIMIT=60MiB ./gc
```

```text
GOGC=off  GOMEMLIMIT=150MiB gc cycles=   23  time=230ms  peak sys= 170 MiB
GOGC=off  GOMEMLIMIT=100MiB gc cycles=   60  time=240ms  peak sys= 124 MiB
GOGC=off  GOMEMLIMIT=60MiB  gc cycles= 7995  time=3.5s   peak sys=  91 MiB
```

With `GOGC=off` the limit alone decides when to collect: no collection until the heap approaches the limit, then as many as are needed. At 150 MiB and 100 MiB the program behaves well, using the headroom above its 64 MiB of live data. Note that peak `Sys` (170, 124 MiB) exceeds the limit, because the limit is **soft**: the runtime makes no guarantee, it only tries, and `Sys` counts memory the runtime has mapped but may already have given back.

The last line is the failure mode. A limit of 60 MiB is **below the live heap**. The program cannot get under it, so the collector runs continuously: 7 995 cycles, and the program took 3.5 s instead of 0.25 s. The runtime tries to limit the damage: the GC guide says it caps GC work at about 50% of CPU time so that a mistaken limit costs at most a 2x slowdown. This run was about fourteen times slower, so treat the cap as damping, not as a guarantee. A limit below the live heap is a bug you will notice immediately.

**How to choose the limit.** The Go GC guide's rule of thumb for a service in a container with a fixed memory size: set `GOMEMLIMIT` to about 90-95% of the container limit, leaving 5-10% for memory the runtime does not account for (C libraries, kernel buffers, thread stacks). Keep `GOGC` at its default so the collector still behaves normally while there is room: the limit only matters when memory is tight. Do **not** use the limit as a way to make a program that is already near its container limit survive: that trades out-of-memory kills for severe slowdowns.

| Setting | Use it when |
|---|---|
| defaults | most programs |
| raise `GOGC` | the program has spare memory and the GC share (`gctrace` percent) is high |
| lower `GOGC` | memory is the constraint and CPU is spare |
| `GOMEMLIMIT` at 90-95% of the container | a service in a container; keeps bursts from triggering OOM kills |
| `GOGC=off` with `GOMEMLIMIT` | batch job in a dedicated, known-size environment; collect only when needed |

## How it works

**Concurrent mark and sweep.** The collector does most work while your goroutines run: it **marks** every reachable value starting from the roots (the stacks and globals), then **sweeps** unmarked memory so it can be reused. It stops the program only for two very short phases (the `ms clock` fields with `+`). While marking, a goroutine that allocates quickly is made to help (**assist**), which slows allocation-heavy code. This is why reducing allocations ([[escape-analysis]], [[pools-builders]]) is the best way to cut GC cost: less garbage means fewer cycles and less assist work.

**Cost depends on live data and pointers, not on garbage.** Marking visits live objects only. A big heap made of pointer-rich structures is costly to mark every cycle; a big heap of `[]byte` buffers (no pointers) is cheap, because the collector need not look inside. Garbage costs nothing to find, since unreachable memory is never visited. That is why the live-heap size drives the formula.

**Containers and CPU.** The number of GC worker threads follows `GOMAXPROCS`. Since Go 1.25 `GOMAXPROCS` defaults to the container's CPU limit rather than the host's core count, so a service limited to 2 CPUs on a 64-core host no longer runs 64 workers.

> [!WARNING]
> Setting `GOGC=off` or a high `GOGC` "to make it faster" without a memory limit is the classic mistake. Symptom: the program is fast in a test and killed by the kernel in production (`OOMKilled` in Kubernetes, exit status 137), because the heap grew with the garbage until the container limit. Fix: leave `GOGC` alone unless `gctrace` shows GC consuming a large share of CPU, always set `GOMEMLIMIT` for containers, and verify with load, not a short test. The opposite error, a `GOMEMLIMIT` below what the program needs, shows as a program that is suddenly many times slower with `gctrace` printing a new line every few milliseconds.

> [!NOTE]
> `runtime/debug.FreeOSMemory()` forces a collection and returns memory to the operating system. The runtime already returns unused memory gradually in the background, so calling it is rarely needed, and a program that calls it in a loop wastes CPU. `runtime/metrics` and `runtime.ReadMemStats` expose the numbers used above (`NumGC`, `HeapAlloc`) for dashboards.

linkcheck's memory use is measured and trimmed in [[step-9-profile]].
