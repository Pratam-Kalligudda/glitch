---
title: Per-iteration loop variables
done_when: "You can explain what a closure or goroutine captures from a for loop in Go 1.22 and later, and why old code needed i := i."
---
(Go 1.22) Every iteration of a `for` loop has its own copy of the loop variable. Before Go
1.22 there was one variable for the whole loop, and every closure, goroutine and pointer that
captured it saw the same variable, which held its last value by the time they ran. That was
one of the most common Go bugs, and the language was changed to remove it.

You still need to know both behaviours: the module's `go` line in `go.mod` decides which one
a package gets, and you will read code written for the old one.

The same file, built twice. Only the `go` line in `go.mod` differs.

```go title="main.go"
package main

import (
	"fmt"
	"slices"
	"sync"
)

func main() {
	// 1. Closures that capture the loop variable.
	var funcs []func() int
	for i := 0; i < 3; i++ {
		funcs = append(funcs, func() int { return i })
	}
	for _, f := range funcs {
		fmt.Print(f(), " ")
	}
	fmt.Println()

	// 2. Pointers to the loop variable.
	var ptrs []*string
	for _, s := range []string{"a", "b", "c"} {
		ptrs = append(ptrs, &s)
	}
	for _, p := range ptrs {
		fmt.Print(*p, " ")
	}
	fmt.Println()

	// 3. Goroutines that capture the loop variable.
	var wg sync.WaitGroup
	var mu sync.Mutex
	var seen []int
	for i := 0; i < 3; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			mu.Lock()
			seen = append(seen, i)
			mu.Unlock()
		}()
	}
	wg.Wait()
	slices.Sort(seen)
	fmt.Println(seen)
}
```

With `go 1.21` in `go.mod`:

```text
3 3 3
c c c
[3 3 3]
```

With `go 1.22` or later (this route uses `go 1.27`):

```text
0 1 2
a b c
[0 1 2]
```

## How it works

**Before Go 1.22 the loop declared one variable.** `for i := 0; i < 3; i++` created `i`
once. Each iteration changed it. A closure that captured `i` captured that single variable,
so after the loop ended every closure read `3`, the value that made the condition false. The
range loop was the same: the `s` in `for _, s := range` was one variable overwritten on each
iteration, so all three pointers pointed to it and printed the last element, `c`. With
goroutines the effect is worse, because when each goroutine runs depends on the scheduler,
so the result changes between runs and often is not even the last value ([[goroutines]]).

**From Go 1.22 each iteration has its own variable.** The compiler gives every iteration a
fresh `i` or `s`. Closures capture the variable of the iteration they were created in, so
they print `0 1 2` and `a b c`.

For the three-clause `for` loop there is a detail: the post statement `i++` must increment
the *next* iteration's variable, not the one a closure may have captured. So at the end of
each iteration the compiler copies the variable's current value to a new variable, and the
post statement then runs on the new one. Changes made inside the body therefore carry over
to the next iteration, but a closure captured earlier keeps its own:

```go title="main.go"
package main

import "fmt"

func main() {
	// Changes in the body carry over to the next iteration.
	var funcs []func() int
	for i := 0; i < 6; i++ {
		if i%2 == 0 {
			i++ // skip an iteration
		}
		funcs = append(funcs, func() int { return i })
	}
	for _, f := range funcs {
		fmt.Print(f(), " ")
	}
	fmt.Println()

	// Each closure owns its iteration's copy, and modifies only that copy.
	var gs []func() int
	for i := 0; i < 3; i++ {
		gs = append(gs, func() int { i += 100; return i })
	}
	fmt.Println(gs[0](), gs[0](), gs[1]())
}
```

```text
1 3 5
100 200 101
```

The first loop skipped from 0 to 1, 2 to 3, and 4 to 5, because the `i++` in the body
changed the value that was copied forward. The second loop shows that the closure `gs[0]`
keeps adding to its own `i`: `100`, then `200`, while `gs[1]` starts from its own `1`.

**The `go` line in `go.mod` decides.** The loop semantics are tied to the language version of
the module (or of a file, with a `//go:build go1.21` constraint). A module that says
`go 1.21` keeps the old behaviour even when built with a newer toolchain, so old code does
not silently change. When you upgrade a module's `go` line, run the tests: code that depended on the shared
variable changes behaviour.

## The old workaround

Before Go 1.22 the fix was to copy the variable inside the loop, so the closure captured the
copy:

```go title="main.go"
package main

import "fmt"

func main() {
	var funcs []func() int
	for i := 0; i < 3; i++ {
		i := i // a new variable, scoped to this iteration
		funcs = append(funcs, func() int { return i })
	}
	for _, f := range funcs {
		fmt.Print(f(), " ")
	}
	fmt.Println()
}
```

```text
0 1 2
```

This still works, and you will see it in older code. In a `go 1.22` module `i := i` is
redundant and can be deleted. Another fix was to pass the value as an argument:
`go func(i int) { ... }(i)`. That is still a good way to make capture explicit.

## What did not change

- Data you point to is still shared. `for _, s := range items { ptrs = append(ptrs, &s) }`
  is correct in Go 1.22, because `&s` is a different address each time, but it points to a
  copy of the item. To point into the slice, take `&items[i]`.
- Goroutines that write shared state still race. The per-iteration `i` fixes *which `i`* a
  goroutine sees, not whether two goroutines write `seen` at once; that is why the example
  above uses a mutex ([[mutexes]]).

> [!WARNING]
> Assuming the new rule in a module whose `go.mod` still says `go 1.21` or lower. Symptom: a
> closure or goroutine in a loop sees the last value, or a pointer slice built from `&v`
> holds the same address repeatedly, even though the identical code works elsewhere. Fix: raise
> the `go` line to 1.22 or later and test, or copy the variable (`i := i`) until you can.

> [!NOTE]
> The change is described in the Go 1.22 release notes, <https://go.dev/doc/go1.22>, and in
> the blog post "Fixing For Loops in Go 1.22", <https://go.dev/blog/loopvar-preview>.

linkcheck's workers in [[step-3-concurrent]] are started in a `for range` loop. They take
their work from a channel, so they need no loop variable and do not depend on this rule.
