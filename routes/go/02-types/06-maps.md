---
title: Maps in depth
---
A **map** is Go's built-in hash table: an unordered collection of key-value pairs with
average constant-time lookup, insert and delete. `map[string]int` maps string keys to int
values. Maps look simple, and the everyday use is, but they come with five rules that
explain every map bug you will meet: missing keys read as zero, iteration order is
random, a `nil` map cannot be written, elements are not addressable, and maps are not safe
for concurrent writes.

## A map of link statuses

```go title="main.go"
package main

import (
	"fmt"
	"maps"
	"slices"
)

func countHosts(urls []string, counts map[string]int) {
	for _, u := range urls {
		counts[u]++ // a missing key reads as 0
	}
}

func main() {
	status := map[string]int{
		"https://go.dev":      200,
		"https://go.dev/doc":  200,
		"https://go.dev/gone": 404,
		"https://go.dev/blog": 200,
		"https://go.dev/play": 301,
	}

	for url, code := range status {
		fmt.Println(code, url)
	}

	code, ok := status["https://go.dev/missing"]
	fmt.Println(code, ok)

	counts := make(map[string]int)
	countHosts([]string{"go.dev", "pkg.go.dev", "go.dev"}, counts)
	fmt.Println(counts) // fmt prints maps sorted by key

	for url, code := range status {
		if code != 200 {
			delete(status, url) // deleting during range is allowed
		}
	}
	fmt.Println(len(status))

	for _, url := range slices.Sorted(maps.Keys(status)) {
		fmt.Println("sorted:", url)
	}

	clear(status)
	fmt.Println(len(status), status == nil)
}
```

```bash
go build -o m.exe .
./m.exe
./m.exe
```

First run:

```text
404 https://go.dev/gone
200 https://go.dev/blog
301 https://go.dev/play
200 https://go.dev
200 https://go.dev/doc
0 false
map[go.dev:2 pkg.go.dev:1]
3
sorted: https://go.dev
sorted: https://go.dev/blog
sorted: https://go.dev/doc
0 false
```

Second run, same binary; only the first five lines differ:

```text
200 https://go.dev/blog
301 https://go.dev/play
200 https://go.dev
200 https://go.dev/doc
404 https://go.dev/gone
```

Your order will differ from both.

## How it works

**Missing keys read as the zero value.** `status["https://go.dev/missing"]` returns `0`,
the zero value of `int`, without an error. That is what makes `counts[u]++` work on a key
that is not there yet. When 0 is also a legitimate value, use the **comma-ok** form:
`code, ok := m[k]` sets `ok` to `false` for a missing key.

**Iteration order is unspecified, and deliberately varied.** The language specification
says the order is not specified and not guaranteed to be the same from one iteration to the
next. The runtime enforces this by starting each `range` at a random position, so code that
accidentally depends on order fails early instead of breaking on the next Go release. When
you need an order, sort the keys: `slices.Sorted(maps.Keys(m))` collects the keys and
sorts them (the `maps` and `slices` packages are covered in [[slices-maps-pkgs]]).
`fmt.Println` sorts map keys itself when printing, which is why `counts` printed in order;
do not mistake that for the map's order.

**Changing a map while ranging over it is allowed.** Deleting an entry you have not reached
yet means it will not be produced. Adding entries during a `range` may or may not produce
them. Deleting the current entry, as above, is safe and common.

**A map value is a reference to the table.** A map variable holds a pointer to the
runtime's hash table. Passing `counts` to `countHosts` copied that pointer, so the function
filled the caller's map. You never need `*map[K]V`.

**`clear(m)`** (Go 1.21) deletes every entry and keeps the map usable, and non-nil.

**Keys must be comparable.** Any type that supports `==` can be a key: numbers, strings,
booleans, pointers, channels, arrays of comparable types, structs whose fields are all
comparable, and interfaces. Slices, maps and functions cannot:

```text
e\e.go:11:13: invalid map key type []string
```

A struct key such as `struct{ Host string; Port int }` is the idiomatic composite key.
Floating-point keys work but `NaN != NaN`, so every `m[math.NaN()] = 1` adds a new entry you
can never look up.

## Map elements are not addressable

The runtime moves entries around as the map grows, so Go does not let you take the address
of a map element or assign to part of one:

```go title="e/e.go"
package e

type Page struct {
	URL    string
	Status int
}

func errors() {
	pages := map[string]Page{"/": {URL: "/"}}
	pages["/"].Status = 200
	bad := map[[]string]int{}
	_ = bad
}
```

```text
# example.com/maps1/e
e\e.go:10:2: cannot assign to struct field pages["/"].Status in map
e\e.go:11:13: invalid map key type []string
```

Read, modify, write back:

```go
p := pages["/"]
p.Status = 200
pages["/"] = p
```

or store pointers, `map[string]*Page`, so `pages["/"].Status = 200` modifies the `Page`
the pointer refers to. Choose pointers when the values are large or are modified often;
values when the map should own independent copies.

## The nil map

```go title="nilmap/main.go"
package main

import "fmt"

type Crawler struct {
	visited map[string]bool
}

func (c *Crawler) Visit(url string) {
	c.visited[url] = true
}

func main() {
	var c Crawler
	fmt.Println(c.visited["/"]) // reading a nil map is fine
	c.Visit("/")                // writing panics
}
```

```text
false
panic: assignment to entry in nil map

goroutine 1 [running]:
main.(*Crawler).Visit(...)
	.../nilmap/main.go:10
main.main()
	.../nilmap/main.go:16 +0x91
exit status 2
```

(Paths in the trace are shortened.) The zero value of a map is `nil` (see
[[zero-values]]): reads, `len`, `range` and `delete` work on it, but there is no table to
insert into.

> [!WARNING]
> A struct with a map field is the usual way to hit `assignment to entry in nil map`: the
> zero value of the struct looks ready, and the first write panics. Either give the type a
> constructor (`func NewCrawler() *Crawler { return &Crawler{visited: map[string]bool{}} }`)
> or initialise lazily inside the method:
> `if c.visited == nil { c.visited = make(map[string]bool) }`. The lazy form keeps the zero
> value useful, which is the idiomatic choice when you can afford the check.

## Maps and goroutines

Maps are not safe for concurrent use when at least one goroutine writes. The runtime
detects it on a best-effort basis and stops the whole program; this is not a panic you can
recover from. Goroutines and `WaitGroup.Go` are taught in [[goroutines]] and [[waitgroup]];
here is just the failure:

```go title="race/main.go"
package main

import (
	"fmt"
	"sync"
)

func main() {
	seen := map[int]bool{}
	var wg sync.WaitGroup
	for i := range 8 {
		wg.Go(func() {
			for j := range 100000 {
				seen[i*100000+j] = true
			}
		})
	}
	wg.Wait()
	fmt.Println(len(seen))
}
```

```text
fatal error: concurrent map writes
```

Guard the map with a mutex (see [[mutexes]]). Concurrent reads with no writer are fine.

| Operation | Syntax | On a nil map |
|---|---|---|
| Create | `make(map[K]V)`, `make(map[K]V, n)`, `map[K]V{...}` | |
| Read | `v := m[k]`, `v, ok := m[k]` | Zero value, `false` |
| Write | `m[k] = v` | Panics |
| Delete | `delete(m, k)` | No-op |
| Delete all | `clear(m)` | No-op |
| Size | `len(m)` | 0 |
| Iterate | `for k, v := range m` | No iterations |

> [!NOTE]
> `make(map[K]V, n)` pre-sizes the table for about n entries, which avoids rehashing while
> you fill it. Since Go 1.24 the runtime's maps are built on Swiss tables, a faster
> hash-table design; the behaviour described here did not change.

linkcheck tracks visited pages in a set built on a map in [[step-2-crawl]]. When crawling goes
concurrent in [[step-3-concurrent]], only the crawl loop touches that map, so it needs no lock.
