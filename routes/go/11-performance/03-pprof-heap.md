---
title: Heap profiling
done_when: "You can write a heap profile, tell inuse_space from alloc_space, and point at the line that retains memory and the line that creates the most garbage."
---
A CPU profile tells you where time goes ([[pprof-cpu]]). A **heap profile** tells you where memory goes: for each allocation site, how many bytes it allocated. It answers two different questions, and the profile keeps a separate count for each:

- **Who is holding memory right now?** (`inuse_space`, `inuse_objects`) The live heap as of the last garbage collection. Use it for a program that grows and never shrinks: a **leak** in Go means memory that is still reachable but no longer needed, such as a map nothing deletes from.
- **Who creates the most garbage?** (`alloc_space`, `alloc_objects`) Everything allocated since the program started, including memory long since freed. Use it when the garbage collector uses too much CPU or the program is slow from allocating.

## A program that does both

`cache` keeps every report forever. `report` also builds a large temporary string for each call that is thrown away:

```go title="main.go"
package main

import (
	"fmt"
	"log"
	"os"
	"runtime"
	"runtime/pprof"
	"strings"
)

// cache keeps every report it has ever built: nothing ever removes entries.
var cache = map[int][]byte{}

// report builds a large temporary string, and keeps only a small result.
func report(id int) []byte {
	var sb strings.Builder
	for i := 0; i < 200; i++ {
		sb.WriteString(fmt.Sprintf("row %d of report %d\n", i, id))
	}
	full := sb.String()
	summary := make([]byte, 4096)
	copy(summary, full)
	return summary
}

func main() {
	for id := 0; id < 2000; id++ {
		cache[id] = report(id) // retained: 4 KiB each, about 8 MiB in total
	}

	var m runtime.MemStats
	runtime.ReadMemStats(&m)
	fmt.Printf("HeapAlloc %d KiB, TotalAlloc %d KiB, Mallocs %d, NumGC %d\n",
		m.HeapAlloc/1024, m.TotalAlloc/1024, m.Mallocs, m.NumGC)

	runtime.GC() // get up-to-date statistics for the profile
	f, err := os.Create("heap.prof")
	if err != nil {
		log.Fatal(err)
	}
	defer f.Close()
	if err := pprof.WriteHeapProfile(f); err != nil {
		log.Fatal(err)
	}
}
```

```bash
go build -o heap .
./heap
```

```text
HeapAlloc 12545 KiB, TotalAlloc 52538 KiB, Mallocs 773138, NumGC 13
```

`runtime.ReadMemStats` gives the quick numbers: `HeapAlloc` is the bytes of heap objects now, `TotalAlloc` the bytes ever allocated, `Mallocs` the number of allocations and `NumGC` the number of garbage collections. The program allocated about 51 MiB in total (`TotalAlloc`) and retains about 12 MiB. The profile says where each number comes from. Your values vary slightly between runs.

`pprof.WriteHeapProfile` writes the profile. The `runtime.GC()` before it matters: heap profile data is only updated at the end of each garbage collection cycle, so without it the profile can be one cycle behind.

## In use: who holds the memory

```bash
go tool pprof -sample_index=inuse_space -top -nodecount=6 heap heap.prof
```

```text
Type: inuse_space
Showing nodes accounting for 10788.14kB, 100% of 10788.14kB total
Showing top 6 nodes out of 26
      flat  flat%   sum%        cum   cum%
 8738.04kB 81.00% 81.00%  9250.13kB 85.74%  main.report
    1026kB  9.51% 90.51%  1538.01kB 14.26%  runtime.mallocgc
  512.09kB  4.75% 95.25%   512.09kB  4.75%  fmt.init.func1
  512.01kB  4.75%   100%   512.01kB  4.75%  runtime.mallocgcSmallScanNoHeaderSC2
         0     0%   100%   512.09kB  4.75%  fmt.Sprintf
         0     0%   100%   512.09kB  4.75%  fmt.newPrinter
```

The columns mean what they do for CPU profiles: `flat` is allocated by the function itself, `cum` includes what it called. `main.report` holds 8.7 MB, 81% of the live heap. (The profile reports slightly less than `HeapAlloc`: it counts sampled objects as of the last collection.) `-list` goes to the line:

```bash
go tool pprof -sample_index=inuse_space -list 'main.report' heap heap.prof
```

```text
ROUTINE ======================== main.report in .../heap/main.go
    8.53MB     9.03MB (flat, cum) 85.74% of Total
         .          .     16:func report(id int) []byte {
         .          .     17:	var sb strings.Builder
         .          .     18:	for i := 0; i < 200; i++ {
         .   512.09kB     19:		sb.WriteString(fmt.Sprintf("row %d of report %d\n", i, id))
         .          .     20:	}
         .          .     21:	full := sb.String()
    8.53MB     8.53MB     22:	summary := make([]byte, 4096)
         .          .     23:	copy(summary, full)
         .          .     24:	return summary
         .          .     25:}
```

Line 22 holds 8.53 MB. The profile does not say "leak" and does not name the cache: it names the allocation site. The next step is yours: who still references what line 22 allocated? The `return summary` goes into `cache[id]`, which never shrinks. Fix it by bounding the cache (a size limit, an expiry, an LRU) or by not caching.

## Allocated: who creates the garbage

```bash
go tool pprof -sample_index=alloc_space -top -nodecount=6 heap heap.prof
```

```text
Type: alloc_space
Showing nodes accounting for 56.64MB, 100% of 56.64MB total
Showing top 6 nodes out of 27
      flat  flat%   sum%        cum   cum%
   32.10MB 56.68% 56.68%    32.10MB 56.68%  strings.(*Builder).WriteString (inline)
   13.03MB 23.01% 79.69%    55.14MB 97.35%  main.report
    9.50MB 16.77% 96.47%       10MB 17.66%  fmt.Sprintf
       1MB  1.77% 98.23%     1.50MB  2.65%  runtime.mallocgc
    0.50MB  0.88%   100%     0.50MB  0.88%  fmt.init.func1
    0.50MB  0.88%   100%     0.50MB  0.88%  runtime.mallocgcSmallScanNoHeaderSC2
```

The view is entirely different. Over its lifetime the program allocated 56 MB, and 32 MB of it is the `strings.Builder` growing as `WriteString` appends (each doubling copies into a bigger array and abandons the old one), plus 9.5 MB from `fmt.Sprintf` creating a string per row only to copy it into the builder. None of that is retained, so none appears in the in-use view. Fixes: `fmt.Fprintf(&sb, ...)` writes straight into the builder with no intermediate string, and `sb.Grow(n)` reserves capacity up front ([[pools-builders]]).

Counting objects rather than bytes is a third view:

```bash
go tool pprof -sample_index=alloc_objects -top -nodecount=5 heap heap.prof
```

```text
Showing nodes accounting for 776228, 99.62% of 779207 total
Dropped 13 nodes (cum <= 3896)
Showing top 5 nodes out of 14
      flat  flat%   sum%        cum   cum%
    415070 53.27% 53.27%     418049 53.65%  fmt.Sprintf
    297100 38.13% 91.40%     745926 95.73%  main.report
    32768  4.21% 95.60%      32768  4.21%  runtime.mallocgcSmallScanNoHeaderSC2
    30777  3.95% 99.55%      30777  3.95%  strings.(*Builder).WriteString (inline)
       513 0.066% 99.62%      33281  4.27%  runtime.mallocgc
```

By count, `fmt.Sprintf` is first: 415 070 allocations. Every allocation costs time to make and time to collect, so a function that makes millions of small objects is expensive even when their total size is small. `alloc_space` finds big allocations; `alloc_objects` finds frequent ones.

## How it works

**The heap profile is sampled.** The runtime records the stack of roughly one allocation per `runtime.MemProfileRate` bytes (default 512 KiB), and the profile scales the counts back up. A function that allocates a few small objects, once, may not appear. Large and frequent sites are always found. Setting `runtime.MemProfileRate = 1` at the start of `main` records every allocation (slow; for a short test only).

**In use means reachable.** The live numbers come from the last completed garbage collection. A value that is garbage but not yet collected is not counted as in-use, because the profile is drawn at collection time. A growing `inuse_space` over several profiles is the signature of a leak: take one profile, run the workload, take another, and compare them with `go tool pprof -base first.prof second.prof`, which shows only what grew.

**Three ways to get a heap profile.**

| Way | Use it for |
|---|---|
| `pprof.WriteHeapProfile(f)` | a command-line program, as above |
| `go test -bench . -memprofile mem.prof` | a benchmark ([[benchmarks]]) |
| `net/http/pprof` at `/debug/pprof/heap` | a running server: `go tool pprof http://localhost:6060/debug/pprof/heap` ([[pprof-cpu]] explains how to mount it safely) |

The leaked-goroutine problem looks different: memory grows because goroutines (and what they reference) pile up. The `goroutine` profile at `/debug/pprof/goroutine?debug=1` counts goroutines per stack and finds those ([[goroutine-leaks]]).

> [!WARNING]
> Reading the wrong sample index is the usual mistake. `go tool pprof heap.prof` opens on `inuse_space` by default; a developer hunting a slow program because of garbage collection looks at it, sees a small live heap, and concludes memory is fine, while `alloc_space` shows gigabytes of churn. Symptom: "the heap is only 20 MB but the GC takes 30% of the CPU". Fix: pick the index to match the question (`-sample_index=alloc_space` for churn, `inuse_space` for retention). Also profile after the program has warmed up and reached a steady state, not during start-up.

> [!NOTE]
> A leak in a Go program is usually a reference that is kept: a map or slice that only grows, a goroutine that never exits, a `time.Ticker` never stopped, a slice that holds a big backing array through a small sub-slice ([[append-aliasing]]). The garbage collector cannot free what is still reachable, so the fix is always to drop the reference.

linkcheck's heap profile in [[step-9-profile]] finds the allocation sites to trim, and [[gc-tuning]] covers how the garbage you produce turns into collection work.
