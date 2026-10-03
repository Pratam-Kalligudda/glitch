---
title: Profile-guided optimisation
done_when: "You can build a binary with a default.pgo profile, confirm with go version -m that it was used, and say how you would decide whether it paid off."
---
The compiler optimises without knowing which code is hot. It inlines small functions, and the rest of its heuristics are guesses. **Profile-guided optimisation** (PGO) gives it the answer: you hand the compiler a CPU profile from a real run ([[pprof-cpu]]) and it spends its effort where the profile shows time going. It inlines hot calls more aggressively and, for interface calls that nearly always go to one concrete type, adds a fast direct path for that type (**devirtualization**). The Go documentation reports typical gains of 2 to 14 percent for representative programs as of Go 1.22. It changes no source code and no behaviour, only the machine code.

## Using it: default.pgo

The convention is a CPU profile named `default.pgo` in the **main package's directory**. `go build` finds it by itself (the default is `-pgo=auto`). Three build flags are enough to remember:

| Flag | Effect |
|---|---|
| `-pgo=auto` (default) | use `default.pgo` in the main package directory if it exists |
| `-pgo=off` | ignore any profile |
| `-pgo=path/to/profile.pprof` | use that profile |

The example program sums areas through an interface in a hot loop, with 90% circles. It has a `-cpuprofile` flag to record its own profile:

```go title="main.go"
package main

import (
	"flag"
	"fmt"
	"log"
	"os"
	"runtime/pprof"
	"time"
)

// Shape is called through an interface in the hot loop.
type Shape interface {
	Area() float64
}

type Rect struct{ W, H float64 }
type Circle struct{ R float64 }
type Tri struct{ B, H float64 }

//go:noinline
func (r Rect) Area() float64 { return r.W * r.H }

//go:noinline
func (c Circle) Area() float64 { return 3.14159 * c.R * c.R }

//go:noinline
func (t Tri) Area() float64 { return 0.5 * t.B * t.H }

// weightedArea is small, called very often and calls through an interface.
func weightedArea(s Shape, w float64) float64 {
	return s.Area() * w
}

// build makes a skewed mix: 90% circles, the rest rectangles and triangles.
func build(n int) []Shape {
	shapes := make([]Shape, n)
	for i := range shapes {
		switch {
		case i%10 < 9:
			shapes[i] = Circle{R: float64(i%7 + 1)}
		case i%20 == 9:
			shapes[i] = Rect{W: 2, H: float64(i%5 + 1)}
		default:
			shapes[i] = Tri{B: 3, H: float64(i%4 + 1)}
		}
	}
	return shapes
}

// total sums the weighted area of every shape.
func total(shapes []Shape) float64 {
	sum := 0.0
	for i, s := range shapes {
		sum += weightedArea(s, 1+float64(i%3))
	}
	return sum
}

func main() {
	profile := flag.String("cpuprofile", "", "write a CPU profile to this file")
	rounds := flag.Int("rounds", 20000, "number of passes over the shapes")
	flag.Parse()
	if *profile != "" {
		f, err := os.Create(*profile)
		if err != nil {
			log.Fatal(err)
		}
		defer f.Close()
		if err := pprof.StartCPUProfile(f); err != nil {
			log.Fatal(err)
		}
		defer pprof.StopCPUProfile()
	}

	shapes := build(1 << 16)
	var result float64
	start := time.Now()
	for range *rounds {
		result = total(shapes)
	}
	perRound := time.Since(start) / time.Duration(*rounds)
	fmt.Printf("total area: %.1f, %v per round\n", result, perRound.Round(time.Microsecond))
}
```

The workflow has four steps:

```bash
# 1. Build normally and record a profile of a representative run.
go build -pgo=off -o base .
./base -cpuprofile cpu.pprof

# 2. Save the profile as default.pgo next to main.go.
cp cpu.pprof default.pgo

# 3. Build again: the go command now uses it automatically.
go build -o withpgo .

# 4. Check that the profile was used.
go version -m withpgo | grep pgo
go version -m base | grep pgo
```

```text
total area: 7516609.9, 132µs per round
	build	-pgo=C:\Users\Pratam\AppData\Local\...\pgo\default.pgo
```

The first line is the profiled run. The `build -pgo=...default.pgo` line from `go version -m` proves the profile went into the build; the second `go version -m` printed no `-pgo` line for the baseline binary. The path is shortened here, and in your build it is your own.

## What the compiler did

`-gcflags=-d=pgodebug=1` makes the compiler explain its use of the profile:

```bash
go build -gcflags=-d=pgodebug=1 -o withpgo .
```

```text
# example.com/pgo
hot-callsite-thres-from-CDF=0.4975124378109453
hot-node enabled increased budget=2000 for func=main.weightedArea
hot-node enabled increased budget=2000 for func=main.total
hot-budget check allows inlining for call main.total (cost 89) at ./main.go:80:17 in function main.main
```

The profile marked `weightedArea` and `total` as **hot**, and the compiler raised their inlining budget to 2000 (the normal limit is 80 "cost" units). `total` costs 89, over the normal budget, so without PGO it stays a call. With the profile it is inlined into `main`. Normal `-m` output shows the difference:

```bash
go build -gcflags=-m -pgo=off . 2>&1 | grep -E "inlining call to (total|weightedArea)"
go build -gcflags=-m -pgo=auto . 2>&1 | grep -E "inlining call to (total|weightedArea)"
```

```text
./main.go:55:22: inlining call to weightedArea
```

```text
./main.go:55:22: inlining call to weightedArea
./main.go:80:17: inlining call to total
./main.go:80:17: inlining call to weightedArea
```

## Does it pay off? Measure.

This is the part that matters, and for this program the honest answer is no. Five runs of each binary, `-rounds 10000`:

```text
off  total area: 7516609.9, 168µs per round
auto total area: 7516609.9, 158µs per round
off  total area: 7516609.9, 149µs per round
auto total area: 7516609.9, 163µs per round
off  total area: 7516609.9, 182µs per round
auto total area: 7516609.9, 191µs per round
off  total area: 7516609.9, 153µs per round
auto total area: 7516609.9, 162µs per round
off  total area: 7516609.9, 154µs per round
auto total area: 7516609.9, 167µs per round
```

The PGO build is not faster; the run-to-run variation (149 to 191 µs) is larger than any difference. PGO changed the code (it inlined `total` into `main`) but the loop's time is dominated by the memory traffic of reading 65 536 interface values and by the calls to `Area` that cannot be inlined, so there was nothing to gain. A real change in your program has to be shown the same way: build with and without, run a benchmark ([[benchmarks]]) several times on a quiet machine, and compare distributions, not single numbers. The tool for that is `benchstat` from `golang.org/x/perf`, which tells you whether a difference is larger than the noise.

PGO helps programs with a large, flat profile: many hot functions spread over a big code base (a compiler, a web server, a database), where inlining and devirtualization across many call sites add up. It helps little in a tight loop that is already as good as the hardware allows.

## How it works

1. **The profile.** A CPU profile records call stacks. The compiler turns them into a weighted call graph and finds the **hot** call sites: the ones that account for most of the time.
2. **Inlining.** Normally a function is inlined only if its cost is under 80. At a hot call site the budget rises to 2000, so larger callees are copied into their callers, saving the call and letting further optimisation see across the boundary.
3. **Devirtualization.** An interface method call looks up the target at run time. If the profile shows one concrete type dominates a call site, the compiler emits `if x is Circle { Circle.Area(x) } else { x.Area() }`, a direct and inlinable call with the old path as the fallback. The benefit depends on the profile really showing a dominant type.
4. **Builds take longer.** The first build with a new profile recompiles every package in the dependency graph, because the profile can affect any package; the results are cached afterwards. Binaries get slightly larger from the extra inlining.

**Good profiles.** Profile the program doing real work, in production if you can: fetch `/debug/pprof/profile?seconds=30` from a running server ([[pprof-cpu]]). A profile from a toy run teaches the compiler the wrong hot spots. To combine profiles from several instances, merge them (the profiles must cover similar durations):

```bash
go tool pprof -proto a.pprof b.pprof > merged.pprof
```

**Keep the profile fresh.** `default.pgo` is committed with the source. Code changes make an old profile less accurate; the compiler tolerates a stale profile (it matches by function name and line offset), so refresh it from time to time rather than on every commit. A profile is a source file in the sense that it changes how the program compiles: review changes to it like any other.

> [!WARNING]
> Treating PGO as a free speed-up is the usual mistake. Symptom: a profile committed, slower builds, a larger binary, and no measurable gain. Fix: decide from measurement. Record the profile from a representative workload, build with `-pgo=off` and with the profile, benchmark both repeatedly, and keep the profile only if the difference is real. Optimise the algorithm first: a better algorithm gains far more than 2 to 14 percent, and PGO is the last step.

> [!NOTE]
> A profile taken from a binary that was itself built with PGO is fine and is the documented steady-state workflow: the profile describes functions, not the layout of the binary. Build with `-pgo=off` to get the baseline, and use `go version -m` to see which profile a binary was built with.

linkcheck records its profile as `default.pgo` in [[step-10-ship]], and the same measurement decides whether to keep it.
