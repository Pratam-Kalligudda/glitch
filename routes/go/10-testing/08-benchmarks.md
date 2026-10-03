---
title: Benchmarks
done_when: "`go test -run='^$' -bench=. -benchmem` prints ns/op, B/op and allocs/op for your benchmark, written with b.Loop, and you can say which of two implementations is faster and by how much."
---
A **benchmark** measures how long an operation takes and how much memory it allocates. It answers questions a profiler cannot answer alone: "is version B faster than version A", "did this change make it slower", "how does cost grow with input size". A benchmark is a function named `BenchmarkXxx` taking a `*testing.B`, in a `_test.go` file next to the tests.

Since Go 1.24 the right way to write the timed loop is `for b.Loop() { ... }`. The older `for i := 0; i < b.N; i++` form still works and is everywhere in existing code, so this stop teaches both and shows what `b.Loop` fixes.

## A first benchmark

This benchmarks the `Normalize` function from [[table-tests]], using the copy with the IPv6 fix from [[fuzzing]]:

```text title="go.mod"
module example.com/bench

go 1.27
```

```go title="urlnorm/bench_test.go"
package urlnorm

import "testing"

func BenchmarkNormalize(b *testing.B) {
	for b.Loop() {
		Normalize("HTTPS://GO.dev:443/doc/install?os=linux#download")
	}
}

func BenchmarkNormalizeCases(b *testing.B) {
	cases := []struct{ name, in string }{
		{"clean", "https://go.dev/doc/"},
		{"messy", "HTTPS://GO.dev:443/doc/install?os=linux#download"},
		{"ipv6", "http://[::1]:8080/a"},
	}
	for _, c := range cases {
		b.Run(c.name, func(b *testing.B) {
			b.ReportAllocs()
			for b.Loop() {
				Normalize(c.in)
			}
		})
	}
}
```

```bash
go test -run='^$' -bench=. ./urlnorm
```

```text
goos: windows
goarch: amd64
pkg: example.com/bench/urlnorm
cpu: 13th Gen Intel(R) Core(TM) i7-1355U
BenchmarkNormalize-12         	 3286689	       314.6 ns/op
BenchmarkNormalizeCases/clean-12         	 5805208	       220.4 ns/op	     176 B/op	       2 allocs/op
BenchmarkNormalizeCases/messy-12         	 3209440	       376.3 ns/op	     208 B/op	       4 allocs/op
BenchmarkNormalizeCases/ipv6-12          	 3132560	       401.4 ns/op	     208 B/op	       5 allocs/op
PASS
ok  	example.com/bench/urlnorm	5.193s
```

The numbers belong to one laptop and vary from run to run; read the shape, not the digits.

## Reading the output

| Part | Means |
|---|---|
| `BenchmarkNormalize-12` | The name, and `GOMAXPROCS` (12 here) after the dash |
| `3286689` | How many times the loop ran. The tool chose it |
| `314.6 ns/op` | Average time for one iteration, in nanoseconds |
| `176 B/op` | Bytes allocated per iteration (shown with `-benchmem` or `b.ReportAllocs()`) |
| `2 allocs/op` | Number of separate heap allocations per iteration |

Allocations matter as much as time: every allocation is work for the garbage collector later ([[escape-analysis]]). `b.ReportAllocs()` turns the two memory columns on for one benchmark; the `-benchmem` flag turns them on for all.

**The command line.** `-bench` takes a regular expression, and nothing runs without it. `-run='^$'` matches no test, so you measure benchmarks without also running every test first. Sub-benchmarks (`b.Run`) are selected like subtests: `-bench=Cases/messy`. Other flags:

| Flag | Does |
|---|---|
| `-bench=regexp` | Run matching benchmarks (`.` is all) |
| `-benchmem` | Report allocations for every benchmark |
| `-benchtime=2s` or `-benchtime=200x` | Run each for a duration (default 1s) or an exact number of iterations |
| `-count=5` | Repeat each benchmark five times, to see the noise |
| `-cpu=1,4` | Run with each listed `GOMAXPROCS` value |
| `-cpuprofile=cpu.out` | Write a CPU profile ([[pprof-cpu]]) |

## How it works: b.Loop, and what it replaces

The tool does not know in advance how many iterations take long enough to measure. With the old form, it calls your function with `b.N = 1`, then 100, then 10000 and so on, until a run takes about the target time, and reports the last. The function is therefore called **many times**, and everything before the loop runs every time. With `b.Loop()` the function is called **once** and `b.Loop` decides internally, per call, whether to continue. A function that prints on entry shows the difference:

```go title="calls/c_test.go"
package calls

import "testing"

func BenchmarkOld(b *testing.B) {
	println("BenchmarkOld function called, b.N =", b.N)
	for i := 0; i < b.N; i++ {
	}
}

func BenchmarkNew(b *testing.B) {
	println("BenchmarkNew function called")
	for b.Loop() {
	}
}
```

```bash
go test -run='^$' -bench=. -benchtime=100ms ./calls
```

```text
BenchmarkOld function called, b.N = 1
BenchmarkOld-12    	BenchmarkOld function called, b.N = 100
BenchmarkOld function called, b.N = 10000
BenchmarkOld function called, b.N = 1000000
BenchmarkOld function called, b.N = 100000000
BenchmarkOld function called, b.N = 1000000000
1000000000	         0.1149 ns/op
BenchmarkNew function called
BenchmarkNew-12    	584692743	         0.2076 ns/op
```

Six calls against one. That is the first thing `b.Loop` fixes: **setup is not repeated and not timed.** `b.Loop` starts the timer on its first call and stops it when it returns false, so code before and after the loop is excluded. In a `b.N` benchmark, setup is inside the timed region unless you remember `b.ResetTimer()`, and it is paid on every call. Here is the difference with a slow setup of 50 ms:

```go title="loops/loops_test.go"
package loops

import (
	"sort"
	"testing"
	"time"
)

func isEven(n int) bool { return n%2 == 0 }

// Old style: the compiler inlines isEven, sees the result is unused, and
// removes the call. The loop measures an empty loop.
func BenchmarkOldLoop(b *testing.B) {
	for i := 0; i < b.N; i++ {
		isEven(42)
	}
}

func BenchmarkLoop(b *testing.B) {
	for b.Loop() {
		isEven(42)
	}
}

func slowSetup() []int {
	time.Sleep(50 * time.Millisecond) // pretend: load a fixture
	s := make([]int, 1000)
	for i := range s {
		s[i] = len(s) - i
	}
	return s
}

// Old style: setup is inside the timed region, and the function runs
// several times with growing b.N, so setup is paid every time.
func BenchmarkOldSetup(b *testing.B) {
	data := slowSetup()
	for i := 0; i < b.N; i++ {
		sort.Ints(append([]int(nil), data...))
	}
}

func BenchmarkSetup(b *testing.B) {
	data := slowSetup() // runs once, not timed
	for b.Loop() {
		sort.Ints(append([]int(nil), data...))
	}
}
```

```bash
go test -run='^$' -bench=. ./loops
```

```text
BenchmarkOldLoop-12     	1000000000	         0.1121 ns/op
BenchmarkLoop-12        	1000000000	         0.6097 ns/op
BenchmarkOldSetup-12    	  194679	      5585 ns/op
BenchmarkSetup-12       	  299085	      4057 ns/op
```

Both setup benchmarks sort the same 1000 numbers. `OldSetup` reports 5585 ns/op, about a third more than `Setup`, because every one of its calls included the 50 ms sleep spread over the iterations. With a short run (`-benchtime=200x`) the effect is dramatic: `OldSetup` printed 262396 ns/op and `Setup` 3480 ns/op, for identical work. A real fixture load, a large input built before the loop or a server started for the benchmark are all setup that must not be in the number.

The second fix is the first pair of lines: **the compiler cannot delete the work.** `isEven(42)` is small, so the compiler inlines it; its result is unused and has no side effect, so it removes the call, and the old loop measures an empty loop: 0.11 nanoseconds per iteration, less than one clock cycle, which no real work can take. Inside a `for b.Loop() {...}` body the compiler keeps the values alive, so the call stays; `BenchmarkLoop` reports 0.61 ns/op for the real work. Per the documentation, this protection applies only to statements between the braces of the `b.Loop` loop. For `b.N` benchmarks the traditional defence is to assign the result to a package-level variable (`var sink bool`), which people forget.

A number like 0.1 ns/op is the sign of this mistake. Anything below about a nanosecond, or an allocation count of 0 for a function that obviously builds a string, means the loop is measuring nothing.

Rules for `b.Loop`:

- Use **either** `b.Loop()` **or** a `b.N` loop in one function, not both.
- Put setup before the loop and cleanup after it; neither is timed.
- Use `b.ResetTimer`, `b.StopTimer` and `b.StartTimer` only for work *inside* the loop that must not count (rare), and prefer to move that work out.
- `b.Fatal` and `b.Error` work as in tests.

## Comparing two implementations

linkcheck remembers every URL it has visited ([[step-2-crawl]]). Should that be a slice searched with `slices.Contains`, or a map? Benchmark both at several sizes, with `b.Run` to give each case its own line:

```go title="visited/visited_test.go"
package visited

import (
	"fmt"
	"slices"
	"testing"
)

func urls(n int) []string {
	out := make([]string, n)
	for i := range out {
		out[i] = fmt.Sprintf("https://go.dev/page/%d", i)
	}
	return out
}

// BenchmarkContains compares two ways to ask "have we seen this URL?".
func BenchmarkContains(b *testing.B) {
	for _, n := range []int{10, 100, 1000} {
		list := urls(n)
		set := make(map[string]struct{}, n)
		for _, u := range list {
			set[u] = struct{}{}
		}
		target := list[n-1] // worst case for the slice

		b.Run(fmt.Sprintf("slice/n=%d", n), func(b *testing.B) {
			for b.Loop() {
				if !slices.Contains(list, target) {
					b.Fatal("missing")
				}
			}
		})
		b.Run(fmt.Sprintf("map/n=%d", n), func(b *testing.B) {
			for b.Loop() {
				if _, ok := set[target]; !ok {
					b.Fatal("missing")
				}
			}
		})
	}
}
```

```bash
go test -run='^$' -bench=. -benchmem ./visited
```

```text
BenchmarkContains/slice/n=10-12         	29805814	        37.64 ns/op	       0 B/op	       0 allocs/op
BenchmarkContains/map/n=10-12           	212864652	         5.662 ns/op	       0 B/op	       0 allocs/op
BenchmarkContains/slice/n=100-12        	 5492062	       219.3 ns/op	       0 B/op	       0 allocs/op
BenchmarkContains/map/n=100-12          	186758480	         6.126 ns/op	       0 B/op	       0 allocs/op
BenchmarkContains/slice/n=1000-12       	  606050	      2193 ns/op	       0 B/op	       0 allocs/op
BenchmarkContains/map/n=1000-12         	100000000	        10.63 ns/op	       0 B/op	       0 allocs/op
```

(The header lines are left out.) The slice cost grows with the number of URLs: about ten times per ten times more elements, which is linear search. The map stays near 6 to 11 nanoseconds. Benchmarking at several sizes is how you see growth; one size hides it. The slice's target is the last element, its worst case, so the benchmark states what it measures.

## Noise: do not trust one run

A laptop's clock speed, background programs and the scheduler all move the numbers. Three consecutive runs of the same benchmark (`-count=3 -benchmem`) printed:

```text
BenchmarkNormalize-12         	 4097911	       290.2 ns/op	     208 B/op	       4 allocs/op
BenchmarkNormalize-12         	 4060870	       311.7 ns/op	     208 B/op	       4 allocs/op
BenchmarkNormalize-12         	 3526964	       440.4 ns/op	     208 B/op	       4 allocs/op
```

290 to 440 for the same code. The allocation columns are identical, because allocations are deterministic; that makes `allocs/op` the most reliable number to compare. To judge a time difference, run old and new each with `-count=10` on a quiet machine, and use a statistics tool such as `benchstat` (from `golang.org/x/perf`) to say whether the difference is larger than the noise. A change under about 5 to 10 per cent is usually noise.

> [!WARNING]
> The common mistake is a benchmark that does not measure what you think. Symptoms: a result under a nanosecond; zero allocations for code that must allocate; or a time that does not change when you change the input size. Fixes: use `for b.Loop()`, keep setup outside the loop, and make the work depend on something the compiler cannot know at compile time (read inputs from a variable, as `c.in` is above). The other trap is comparing numbers from different machines or from one run each.

> [!NOTE]
> `b.RunParallel` runs the body from many goroutines to measure contention on shared state, with `pb.Next()` as the loop condition. Use it for a cache or a counter, not for ordinary functions. For where a slow benchmark spends its time, take a profile with `-cpuprofile` ([[pprof-cpu]]).

linkcheck's step 9 benchmarks its crawl and uses allocations per operation as the number to bring down: [[step-9-profile]].
