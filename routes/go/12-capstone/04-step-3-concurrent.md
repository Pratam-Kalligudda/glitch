---
title: "Step 3: check concurrently"
done_when: "With `-v`, every link except `/slow` is logged within a few milliseconds of the start and `progress checked=9 broken=4` is logged once a second while `/slow` loads, and pressing Ctrl-C while `/slow` loads prints a report ending in `interrupted: this report is partial` and exits with status 130."
---
linkcheck now checks links with a pool of worker goroutines, passes a context to every request, and stops cleanly on Ctrl-C with a partial report.

Do this yourself first, then compare.

1. Start `-workers` goroutines with `sync.WaitGroup.Go`, each ranging over an unbuffered `jobs` channel ([[goroutines]], [[channels]], [[waitgroup]], [[worker-pools]]).
2. Keep the queue, the visited set and the results in one coordinator goroutine, so no lock is needed; workers only send results back ([[memory-model]], [[pipelines]]).
3. In the coordinator, `select` over sending the next job, receiving a result, and `ctx.Done()`, and switch the send off with a nil channel when the queue is empty ([[select]]).
4. Make every worker give up its send when the context is cancelled, close `jobs`, and wait for the workers before returning, so no goroutine outlives `Run` ([[goroutine-leaks]], [[context]]).
5. In `main`, cancel the context on the first Ctrl-C with `signal.NotifyContext`, and exit with 130 after printing what was checked ([[signals]], [[exit-codes]]).
6. Add a `-v` flag that switches a `slog` text handler on stderr from `Warn` to `Debug` ([[slog]]).
7. Count checked and broken links with `atomic.Int64` in the workers, and with `-v` log those counters every second from a separate goroutine ([[once-atomic]]).
8. Sort the results by URL with `slices.SortFunc` and `strings.Compare`, because workers finish in any order ([[compare-sort]]).

## The code

New: `progress.go`. Changed: `internal/crawl/crawler.go`, `internal/crawl/result.go`, `main.go`. Unchanged: `go.mod`, `go.sum`, `internal/crawl/fetch.go`, `links.go`, `normalize.go`, `errors.go`, `set.go`, and `cmd/testsite`.

```go title="internal/crawl/crawler.go"
package crawl

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"net/url"
	"sync"
	"sync/atomic"
	"time"
)

// Crawler checks every link on a site, following links on the start URL's
// host up to MaxDepth clicks away. Links to other hosts are checked but
// not followed.
type Crawler struct {
	Fetcher  *HTTPFetcher
	MaxDepth int
	Workers  int          // how many URLs to check at once; at least 1
	Logger   *slog.Logger // nil means no logging

	checked atomic.Int64 // URLs checked so far; read with Progress
	broken  atomic.Int64 // how many of those were broken
}

type job struct {
	url    string
	parent string
	depth  int
}

// done is what a worker sends back after visiting a job.
type done struct {
	res   Result
	links []string
}

// Run crawls from start and returns one Result per distinct URL, in the
// order the checks finished.
//
// If ctx is cancelled, Run stops starting new checks, waits for its
// workers to exit, and returns the results gathered so far together with
// ctx.Err().
func (c *Crawler) Run(ctx context.Context, start string) ([]Result, error) {
	startURL, err := url.Parse(start)
	if err != nil {
		return nil, err
	}
	first, err := Normalize(startURL, "")
	if err != nil {
		return nil, err
	}
	log := c.Logger
	if log == nil {
		log = slog.New(slog.DiscardHandler)
	}

	jobs := make(chan job)
	finished := make(chan done)
	var wg sync.WaitGroup
	for range max(c.Workers, 1) {
		wg.Go(func() {
			for j := range jobs {
				res, links := c.visit(ctx, j, startURL.Host)
				c.checked.Add(1)
				if res.Err != nil {
					c.broken.Add(1)
				}
				select {
				case finished <- done{res, links}:
				case <-ctx.Done():
					return
				}
			}
		})
	}

	var visited Set[string]
	visited.Add(first)
	queue := []job{{url: first}}
	inFlight := 0
	var results []Result

loop:
	for len(queue) > 0 || inFlight > 0 {
		// A nil channel blocks forever, so with an empty queue the send
		// case is switched off and select waits for results only.
		var send chan job
		var next job
		if len(queue) > 0 {
			send, next = jobs, queue[0]
		}
		select {
		case send <- next:
			queue = queue[1:]
			inFlight++
		case d := <-finished:
			inFlight--
			if ctx.Err() != nil {
				break loop // the check may have been cut short; drop it
			}
			results = append(results, d.res)
			log.Debug("checked", "url", d.res.URL, "status", d.res.Status,
				"depth", d.res.Depth, "took", d.res.Duration.Round(time.Millisecond))
			for _, link := range d.links {
				if visited.Add(link) {
					queue = append(queue, job{url: link, parent: d.res.URL, depth: d.res.Depth + 1})
				}
			}
		case <-ctx.Done():
			break loop
		}
	}

	close(jobs)
	wg.Wait()
	if err := ctx.Err(); err != nil {
		log.Warn("crawl stopped", "checked", len(results), "queued", len(queue), "in_flight", inFlight)
		return results, err
	}
	return results, nil
}

// Progress reports how many URLs the workers have checked so far and how
// many of those were broken. It is safe to call from any goroutine while
// Run is running.
func (c *Crawler) Progress() (checked, broken int64) {
	return c.checked.Load(), c.broken.Load()
}

// visit checks one URL. If the URL is an HTML page on the start host and
// is not too deep, it also returns the links on the page.
func (c *Crawler) visit(ctx context.Context, j job, host string) (Result, []string) {
	res := Result{URL: j.url, Parent: j.parent, Depth: j.depth}
	begin := time.Now()
	page, err := c.Fetcher.Fetch(ctx, j.url)
	res.Duration = time.Since(begin)
	if err != nil {
		// The client wraps its errors in *url.Error, which repeats the
		// method and URL; keep only the cause.
		if ue, ok := errors.AsType[*url.Error](err); ok {
			err = ue.Err
		}
		res.Err = &LinkError{URL: j.url, Err: err}
		return res, nil
	}
	res.Status = page.Status
	if page.Status >= 400 {
		res.Err = &LinkError{URL: j.url, Status: page.Status, Err: ErrBadStatus}
		return res, nil
	}

	final, err := url.Parse(page.URL)
	if err != nil || final.Host != host || !page.HTML() || j.depth >= c.MaxDepth {
		return res, nil
	}
	links, err := Links(final, bytes.NewReader(page.Body))
	if err != nil {
		return res, nil // a page that does not parse still loaded fine
	}
	return res, links
}
```

How `Run` works:

1. It starts the workers first. Each one reads jobs until `jobs` is closed, visits the URL with the shared context, and sends a `done` back.
2. The coordinator loop runs while there is work queued or in flight. Only the coordinator touches `queue`, `visited`, `inFlight` and `results`, so they need no mutex: the channel operations are the synchronization.
3. When the queue is empty, `send` stays nil. A send on a nil channel never proceeds, so `select` waits for a result or for cancellation instead of spinning.
4. On Ctrl-C, `ctx.Done()` is closed. The loop breaks; requests in flight fail fast because they carry `ctx`; workers blocked on `finished <- ...` take the `ctx.Done()` branch; workers waiting in `range jobs` see the channel closed. `wg.Wait()` returns only when all of them have exited.
5. A result that arrives after cancellation is dropped, because its request may have been cut short and its error would be `context canceled`, not a fact about the link.

Without the `ctx.Done()` case in the worker, an interrupted crawl would leave a worker blocked forever on `finished <- ...` with nobody receiving, and `wg.Wait()` would never return.

The two counters are the exception to "only the coordinator touches state". Workers increment them, and `Progress` reads them from whatever goroutine asks, while `Run` is still going. A plain `int64` there would be a data race; `atomic.Int64` makes each `Add` and `Load` indivisible and visible to the other goroutines. They are unexported, so callers can only read them through `Progress`, and because an `atomic.Int64` must not be copied, a `Crawler` is always used through a pointer.

```go title="internal/crawl/result.go"
package crawl

import "time"

// Outcome classifies a checked link.
type Outcome int

const (
	OK     Outcome = iota // the link works
	Broken                // the link returned an error status or no response
)

func (o Outcome) String() string {
	switch o {
	case OK:
		return "ok"
	case Broken:
		return "broken"
	}
	return "unknown"
}

// Result is what the crawler learned about one URL.
type Result struct {
	URL    string
	Parent string // the page the link was first found on; "" for a start URL
	Depth  int    // clicks from the start URL
	Status int    // HTTP status, or 0 if no response arrived
	Err    error  // a *LinkError when the link is broken

	Duration time.Duration // how long the request took
}

// Outcome reports whether the link works.
func (r Result) Outcome() Outcome {
	if r.Err != nil {
		return Broken
	}
	return OK
}
```

```go title="progress.go"
package main

import (
	"log/slog"
	"time"

	"example.com/linkcheck/internal/crawl"
)

// progressEvery is how often -v logs the crawl's progress.
const progressEvery = time.Second

// logProgress logs the crawler's counters every progressEvery until the
// returned stop function is called. stop waits for the logging goroutine
// to exit, so nothing is logged after it returns.
func logProgress(log *slog.Logger, c *crawl.Crawler) (stop func()) {
	quit := make(chan struct{})
	exited := make(chan struct{})
	go func() {
		defer close(exited)
		t := time.NewTicker(progressEvery)
		defer t.Stop()
		for {
			select {
			case <-t.C:
				checked, broken := c.Progress()
				log.Info("progress", "checked", checked, "broken", broken)
			case <-quit:
				return
			}
		}
	}()
	return func() {
		close(quit)
		<-exited
	}
}
```

`stop` closes `quit` and then waits on `exited`, so when it returns the goroutine is gone and the ticker is stopped. Without that wait, a last "progress" line could appear after the report.

```go title="main.go"
// Command linkcheck crawls a website and reports broken links.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"slices"
	"strings"

	"example.com/linkcheck/internal/crawl"
)

// Exit codes.
const (
	exitOK          = 0   // every link works
	exitBroken      = 1   // at least one link is broken
	exitError       = 2   // linkcheck could not run
	exitInterrupted = 130 // stopped by Ctrl-C; the report is partial
)

// config holds the settings from the command line.
type config struct {
	depth   int
	workers int
	verbose bool
}

func main() {
	var cfg config
	flag.IntVar(&cfg.depth, "depth", 3, "follow links up to `n` clicks from the start page")
	flag.IntVar(&cfg.workers, "workers", 8, "check up to `n` links at once")
	flag.BoolVar(&cfg.verbose, "v", false, "log every check to stderr")
	flag.Usage = func() {
		fmt.Fprintln(flag.CommandLine.Output(), "usage: linkcheck [flags] URL")
		flag.PrintDefaults()
	}
	flag.Parse()
	if flag.NArg() != 1 {
		flag.Usage()
		os.Exit(exitError)
	}

	// The first Ctrl-C cancels ctx; stop restores the default behaviour,
	// so a second Ctrl-C kills the process at once.
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	code := run(ctx, cfg, flag.Arg(0), os.Stdout, os.Stderr)
	stop()
	os.Exit(code)
}

func run(ctx context.Context, cfg config, start string, stdout, stderr io.Writer) int {
	level := slog.LevelWarn
	if cfg.verbose {
		level = slog.LevelDebug
	}
	logger := slog.New(slog.NewTextHandler(stderr, &slog.HandlerOptions{Level: level}))

	c := &crawl.Crawler{
		Fetcher:  &crawl.HTTPFetcher{Client: &http.Client{}},
		MaxDepth: cfg.depth,
		Workers:  cfg.workers,
		Logger:   logger,
	}
	stopProgress := func() {}
	if cfg.verbose {
		stopProgress = logProgress(logger, c)
	}
	results, err := c.Run(ctx, start)
	stopProgress()
	interrupted := errors.Is(err, context.Canceled)
	if err != nil && !interrupted {
		fmt.Fprintf(stderr, "linkcheck: %v\n", err)
		return exitError
	}
	if len(results) == 0 {
		fmt.Fprintln(stderr, "linkcheck: interrupted before the start page loaded")
		return exitInterrupted
	}
	// The start page is the only job at first, so it finishes first.
	if results[0].Err != nil {
		fmt.Fprintf(stderr, "linkcheck: start page: %v\n", results[0].Err)
		return exitError
	}

	// Workers finish in any order; sort so the report is stable.
	slices.SortFunc(results, func(a, b crawl.Result) int {
		return strings.Compare(a.URL, b.URL)
	})
	broken := 0
	for _, r := range results {
		if r.Outcome() == crawl.OK {
			continue
		}
		broken++
		printBroken(stdout, r)
	}
	fmt.Fprintf(stdout, "%d links checked, %d broken\n", len(results), broken)
	switch {
	case interrupted:
		fmt.Fprintln(stdout, "interrupted: this report is partial")
		return exitInterrupted
	case broken > 0:
		return exitBroken
	}
	return exitOK
}

// printBroken prints a broken link, the page it is on, and the network
// error if there was no HTTP response.
func printBroken(w io.Writer, r crawl.Result) {
	status := "ERR"
	if r.Status != 0 {
		status = fmt.Sprint(r.Status)
	}
	fmt.Fprintf(w, "%-4s %s\n", status, r.URL)
	fmt.Fprintf(w, "     on %s\n", r.Parent)
	if le, ok := errors.AsType[*crawl.LinkError](r.Err); ok && !errors.Is(le, crawl.ErrBadStatus) {
		fmt.Fprintf(w, "     %v\n", le.Err)
	}
}
```

`os.Exit` does not run deferred functions, so `main` calls `stop()` itself before exiting; the `defer` covers the path where `run` panics. Calling `stop` twice is safe.

## Run it

With the testsite running:

```bash
go build .
./linkcheck http://127.0.0.1:8080/
```

```text
404  http://127.0.0.1:8080/blog/archive/2019.html
     on http://127.0.0.1:8080/blog/post-1.html
404  http://127.0.0.1:8080/blog/drafts/
     on http://127.0.0.1:8080/blog/post-2.html
500  http://127.0.0.1:8080/error
     on http://127.0.0.1:8080/
404  http://127.0.0.1:8080/missing.html
     on http://127.0.0.1:8080/
404  http://127.0.0.1:8080/team.html
     on http://127.0.0.1:8080/about.html
404  http://127.0.0.1:8081/gone
     on http://127.0.0.1:8080/
ERR  http://127.0.0.1:8099/
     on http://127.0.0.1:8080/
     dial tcp 127.0.0.1:8099: connectex: No connection could be made because the target machine actively refused it.
ERR  https://127.0.0.1:8081/ok.html
     on http://127.0.0.1:8080/blog/post-2.html
     http: server gave HTTP response to HTTPS client
17 links checked, 8 broken
```

The same 17 links and 8 broken ones as step 2, now sorted by URL. One line can change between runs: `team.html` is linked from `about.html`, and `/old-page` redirects to `about.html`, so whichever of the two finishes first is recorded as the parent (some runs print `on http://127.0.0.1:8080/old-page`). That is a real property of concurrent crawling: "first found on" now depends on timing.

Watch the timing with `-v`, discarding stdout:

```bash
./linkcheck -v -depth 1 http://127.0.0.1:8080/ > /dev/null
```

```text
time=2026-10-03T14:33:29.330+05:30 level=DEBUG msg=checked url=http://127.0.0.1:8080/ status=200 depth=0 took=3ms
time=2026-10-03T14:33:29.332+05:30 level=DEBUG msg=checked url=http://127.0.0.1:8081/ok.html status=200 depth=1 took=1ms
time=2026-10-03T14:33:29.332+05:30 level=DEBUG msg=checked url=http://127.0.0.1:8081/gone status=404 depth=1 took=1ms
time=2026-10-03T14:33:29.332+05:30 level=DEBUG msg=checked url=http://127.0.0.1:8080/about.html status=200 depth=1 took=1ms
time=2026-10-03T14:33:29.332+05:30 level=DEBUG msg=checked url=http://127.0.0.1:8080/error status=500 depth=1 took=1ms
time=2026-10-03T14:33:29.333+05:30 level=DEBUG msg=checked url=http://127.0.0.1:8080/missing.html status=404 depth=1 took=1ms
time=2026-10-03T14:33:29.333+05:30 level=DEBUG msg=checked url=http://127.0.0.1:8080/blog/ status=200 depth=1 took=1ms
time=2026-10-03T14:33:29.333+05:30 level=DEBUG msg=checked url=http://127.0.0.1:8080/old-page status=200 depth=1 took=2ms
time=2026-10-03T14:33:29.333+05:30 level=DEBUG msg=checked url=http://127.0.0.1:8099/ status=0 depth=1 took=0s
time=2026-10-03T14:33:30.329+05:30 level=INFO msg=progress checked=9 broken=4
time=2026-10-03T14:33:31.329+05:30 level=INFO msg=progress checked=9 broken=4
time=2026-10-03T14:33:32.329+05:30 level=INFO msg=progress checked=9 broken=4
time=2026-10-03T14:33:32.333+05:30 level=DEBUG msg=checked url=http://127.0.0.1:8080/slow status=200 depth=1 took=3.002s
```

Every other link finishes within four milliseconds of the start page; only `/slow` takes its three seconds. The `progress` lines come from the ticker goroutine reading the atomic counters once a second while `/slow` holds the crawl open: nine checked, four broken. In step 2 every link queued behind `/slow` waited for it. The run now takes as long as the slowest request, not the sum of all of them. Timestamps and durations differ on your machine; the shape does not.

Now interrupt it. Run the crawl again and press Ctrl-C about a second in, while `/slow` is still loading:

```bash
./linkcheck http://127.0.0.1:8080/; echo "exit $?"
```

```text
time=2026-10-03T14:12:28.885+05:30 level=WARN msg="crawl stopped" checked=16 queued=0 in_flight=1
404  http://127.0.0.1:8080/blog/archive/2019.html
     on http://127.0.0.1:8080/blog/post-1.html
404  http://127.0.0.1:8080/blog/drafts/
     on http://127.0.0.1:8080/blog/post-2.html
500  http://127.0.0.1:8080/error
     on http://127.0.0.1:8080/
404  http://127.0.0.1:8080/missing.html
     on http://127.0.0.1:8080/
404  http://127.0.0.1:8080/team.html
     on http://127.0.0.1:8080/about.html
404  http://127.0.0.1:8081/gone
     on http://127.0.0.1:8080/
ERR  http://127.0.0.1:8099/
     on http://127.0.0.1:8080/
     dial tcp 127.0.0.1:8099: connectex: No connection could be made because the target machine actively refused it.
ERR  https://127.0.0.1:8081/ok.html
     on http://127.0.0.1:8080/blog/post-2.html
     http: server gave HTTP response to HTTPS client
16 links checked, 8 broken
interrupted: this report is partial
exit 130
```

The warning on stderr says one check was in flight: `/slow`. Its request was cancelled, its result dropped, and the program exited at once instead of waiting out the three seconds.

> [!NOTE]
> On Windows, Go delivers both Ctrl-C and Ctrl-Break to a program as `os.Interrupt`. A `kill -INT` from Git Bash does not reach a native Windows program; press Ctrl-C in its console instead.

`/slow` still holds up the end of every full crawl, and nothing stops linkcheck from sending eight requests at once to a small server. [[step-4-polite]] adds timeouts and a rate limit.
