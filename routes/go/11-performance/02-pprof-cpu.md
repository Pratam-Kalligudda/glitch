---
title: CPU profiling
done_when: "You can record a CPU profile of a program, read go tool pprof -top and -list output, and name the function that is spending the time."
---
When a program is slow, guessing where is the usual mistake. A **profiler** answers with data: it samples the running program many times a second, records which functions were on the call stack, and reports where the time went. Go's profiler is built in and is called **pprof**. A CPU profile samples about 100 times per second; a function that appears in 30% of the samples was running (or waiting on something it called) for about 30% of the time.

## A program with a hidden cost

The program below parses 20 000 fake log lines. `parse` has a flaw that is easy to write and hard to see: it compiles its regular expression on every call. `-cpuprofile` writes a profile to a file with `runtime/pprof`:

```go title="main.go"
package main

import (
	"flag"
	"fmt"
	"log"
	"os"
	"regexp"
	"runtime/pprof"
	"strconv"
	"time"
)

// makeLines builds n fake access-log lines.
func makeLines(n int) []string {
	lines := make([]string, n)
	for i := range lines {
		lines[i] = "GET /page/" + strconv.Itoa(i%500) + " 200 " + strconv.Itoa(100+i%900) + "ms"
	}
	return lines
}

// parse extracts the path and the duration from one line.
// It compiles the regular expression on every call.
func parse(line string) (path string, ms int) {
	re := regexp.MustCompile(`^GET (\S+) \d+ (\d+)ms$`)
	m := re.FindStringSubmatch(line)
	if m == nil {
		return "", 0
	}
	ms, _ = strconv.Atoi(m[2])
	return m[1], ms
}

// lineRE is compiled once, when the program starts.
var lineRE = regexp.MustCompile(`^GET (\S+) \d+ (\d+)ms$`)

// parseFast does the same work with the precompiled expression.
func parseFast(line string) (path string, ms int) {
	m := lineRE.FindStringSubmatch(line)
	if m == nil {
		return "", 0
	}
	ms, _ = strconv.Atoi(m[2])
	return m[1], ms
}

func main() {
	profile := flag.String("cpuprofile", "", "write a CPU profile to this file")
	fast := flag.Bool("fast", false, "use the precompiled regular expression")
	flag.Parse()

	if *profile != "" {
		f, err := os.Create(*profile)
		if err != nil {
			log.Fatal(err)
		}
		if err := pprof.StartCPUProfile(f); err != nil {
			log.Fatal(err)
		}
		defer pprof.StopCPUProfile()
	}

	lines := makeLines(20_000)
	start := time.Now()
	total := map[string]int{}
	parseLine := parse
	if *fast {
		parseLine = parseFast
	}
	for _, l := range lines {
		path, ms := parseLine(l)
		total[path] += ms
	}
	fmt.Println("pages:", len(total), "time:", time.Since(start).Round(10*time.Millisecond))
}
```

```bash
go build -o cpu .
./cpu -cpuprofile slow.prof
```

```text
pages: 500 time: 1.77s
```

`StartCPUProfile` begins sampling and `StopCPUProfile` (deferred) flushes the file when `main` returns. Timings on a laptop vary a lot from run to run; the numbers here are one real run, not a promise.

## Reading the profile

`go tool pprof` reads the profile. Give it the binary too, so it can name functions and show source lines. `-top` prints a table:

```bash
go tool pprof -top -nodecount=8 cpu slow.prof
```

```text
Duration: 1.74s, Total samples = 2000ms (114.69%)
Showing nodes accounting for 1100ms, 55.00% of 2000ms total
Showing top 8 nodes out of 211
      flat  flat%   sum%        cum   cum%
     320ms 16.00% 16.00%      320ms 16.00%  runtime.osyield.func1
     270ms 13.50% 29.50%      300ms 15.00%  runtime.preemptM
     120ms  6.00% 35.50%      120ms  6.00%  runtime.pcdatavalue
     120ms  6.00% 41.50%      130ms  6.50%  runtime.tryDeferToSpanScan
     110ms  5.50% 47.00%      110ms  5.50%  runtime.semasleep
      60ms  3.00% 50.00%       60ms  3.00%  runtime.sysUnusedOS
      50ms  2.50% 52.50%      310ms 15.50%  runtime.lock2
      50ms  2.50% 55.00%       50ms  2.50%  runtime.procyieldAsm
```

The columns:

| Column | Meaning |
|---|---|
| `flat` | time spent in the function's own code |
| `flat%` | `flat` as a share of all samples |
| `sum%` | running total of `flat%` down the list |
| `cum` | cumulative: time in the function **and everything it called** |
| `cum%` | `cum` as a share of all samples |

The header's `Total samples = 2000ms (114.69%)` is above 100% because several threads ran at once: the garbage collector's workers sample alongside the main goroutine.

The sorted-by-`flat` view is a list of runtime functions (`osyield`, `preemptM`, lock and scheduler code) and nothing from our program. That is real information: the program spent its time allocating and collecting garbage, and runtime overhead (scheduler, locks, thread preemption) dominates the flat list. When the flat list is all runtime, switch to **cumulative** order, which ranks a function by everything beneath it:

```bash
go tool pprof -top -cum -nodecount=25 cpu slow.prof
```

```text
Showing nodes accounting for 0.65s, 32.50% of 2s total
Showing top 25 nodes out of 211
      flat  flat%   sum%        cum   cum%
         0     0%     0%      0.93s 46.50%  runtime.systemstack
         0     0%     0%      0.65s 32.50%  main.main
         0     0%     0%      0.65s 32.50%  runtime.main
         0     0%     0%      0.62s 31.00%  main.parse
         0     0%     0%      0.55s 27.50%  runtime.gcBgMarkWorker.func2
         0     0%     0%      0.55s 27.50%  runtime.gcDrain
         0     0%     0%      0.52s 26.00%  regexp.Compile (inline)
         0     0%     0%      0.52s 26.00%  regexp.MustCompile
         0     0%     0%      0.52s 26.00%  regexp.compile
         0     0%     0%      0.38s 19.00%  runtime.markroot
...
```

(The remaining rows are more runtime scheduling and garbage collector functions, omitted here.) Now the story is visible. `main.main` accounts for 0.65 s of the samples, `main.parse` for 0.62 s of that, and `regexp.MustCompile` for 0.52 s: **most of the time is spent compiling a regular expression 20 000 times**. The garbage collector (`gcBgMarkWorker`, `gcDrain`, 0.55 s) is the cost of the garbage that compiling produces. The code that looks hot (matching, `Atoi`, the map) hardly shows.

`-list` shows the cost per source line of one function:

```bash
go tool pprof -list 'main.parse$' cpu slow.prof
```

```text
ROUTINE ======================== main.parse in .../cpu/main.go
         0      620ms (flat, cum) 31.00% of Total
         .          .     25:func parse(line string) (path string, ms int) {
         .      520ms     26:	re := regexp.MustCompile(`^GET (\S+) \d+ (\d+)ms$`)
         .      100ms     27:	m := re.FindStringSubmatch(line)
         .          .     28:	if m == nil {
         .          .     29:		return "", 0
         .          .     30:	}
         .          .     31:	ms, _ = strconv.Atoi(m[2])
         .          .     32:	return m[1], ms
```

The path in the first line is shortened. Line 26 costs 520 ms, line 27 (the matching itself) 100 ms. The argument of `-list` is a regular expression matched against function names; `$` stops it from also matching `main.parseFast`.

The fix is to compile once, in a package-level variable. The `-fast` flag runs that version:

```bash
./cpu -fast
```

```text
pages: 500 time: 10ms
```

More than a hundred times faster here. A profile of the fast run has no samples at all: `Duration: 14.21ms, Total samples = 0`. A program that finishes in a few milliseconds is too short for a sampler that fires 100 times a second. Profile with more input or a loop, never with a run that takes less than a second or two.

## How it works

**Sampling.** Every 10 ms the runtime interrupts the program and records the call stack of what was running. A profile is a table of stacks and their counts; `pprof` adds them up per function. Sampling is cheap enough to leave on in production, and its result is statistical: small functions that take under a couple of percent are noise.

**Flat versus cum.** `flat` finds the function that burns CPU itself (a hot loop). `cum` finds the function whose callees are expensive (a caller that does too much work, as `parse` does). Start with `-cum` to find which of your functions matters, then `-list` that function.

**Three ways to get a profile.**

| Way | Use it for |
|---|---|
| `runtime/pprof.StartCPUProfile(w)` | a command-line program, as above |
| `go test -bench . -cpuprofile cpu.prof` | a benchmark of one piece of code ([[benchmarks]]) |
| `import _ "net/http/pprof"` | a running server: fetch `/debug/pprof/profile?seconds=30` |

`net/http/pprof` registers handlers on `http.DefaultServeMux` when imported for its side effects. Since a server built with its own `ServeMux` ([[http-server]]) does not use the default mux, mount the handlers explicitly (`mux.HandleFunc("/debug/pprof/", pprof.Index)` and its siblings) and serve them on a separate, private address: the endpoints expose internals and can slow the process down.

```bash
go tool pprof -http=:8080 cpu slow.prof
```

`-http` opens a web interface with the table, a call graph and a flame graph, in which wide boxes are expensive stacks. The graph view needs Graphviz installed; the flame graph and table do not.

> [!WARNING]
> Optimising from intuition, or from a profile taken in the wrong conditions, is the common mistake. Symptom: a day spent speeding up a function that the profile would have shown at 1%, or a profile with almost no samples, or dominated by startup. Fix: profile a realistic workload for several seconds, look at `-cum` first, change one thing, and measure the same workload again. Compile-once is the classic find: `regexp.MustCompile`, `template.Parse`, `time.LoadLocation` and `json` encoder setup inside a request handler or a loop.

> [!NOTE]
> A CPU profile shows only time on a CPU. A program waiting for a network reply or a lock uses no CPU and does not appear; a program that is slow because it is blocked needs the block and mutex profiles or an execution trace ([[tracing]]). Memory is the next profile to learn: [[pprof-heap]].

linkcheck is profiled with exactly this flag and `-list` workflow in [[step-9-profile]]. The profile is also the input that profile-guided optimisation uses to rebuild a faster binary ([[pgo]]).
