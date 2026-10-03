---
title: "Step 4: be polite"
done_when: "`-timeout 1s` reports `/slow` as `timed out after 1s` and the crawl finishes in under two seconds; with `-v -rate 2/s` the checks on port 8080 finish about half a second apart; `-check-tcp` against port 8099 exits with status 2 before crawling."
---
linkcheck now limits how fast it requests each host, gives up on slow requests, takes its rate as a custom flag type, identifies itself with a User-Agent, accepts several start URLs, and can check that each start host accepts TCP connections before it crawls.

Do this yourself first, then compare.

1. Add `golang.org/x/time/rate` and `golang.org/x/sync/errgroup` with `go get` and pin the versions you get ([[dependencies]]).
2. Write `HostLimiter`: one `rate.Limiter` per host in a map guarded by a `sync.Mutex`, and call `Wait` before each request ([[rate-limiting]], [[mutexes]]).
3. Give each request its own deadline with `context.WithTimeout`, cancel it with `defer`, and turn our own deadline into the sentinel `ErrTimeout` with `%w` ([[context]], [[defer]], [[wrapping]]).
4. Write `rateFlag`, a `flag.Value` that parses `10/s`, `30/m` and `1/500ms` with `strings.Cut`, `strconv.Atoi` and `time.ParseDuration` ([[flags-args]], [[strings-pkg]], [[strconv]], [[time-pkg]]).
5. Write `checkTCP`: dial every start host at once with `net.Dialer.DialContext` inside an `errgroup.WithContext`, and return the first failure ([[net-tcp]], [[errgroup]]).
6. Set a `User-Agent` header on every request ([[http-client]]).
7. Accept several start URLs with a variadic `Run`, and keep their hosts in the `Set` from step 2 ([[generic-types]]).

## The code

New: `flags.go`, `preflight.go`, `internal/crawl/limit.go`. Changed: `go.mod`, `go.sum`, `main.go`, `internal/crawl/crawler.go`, `internal/crawl/fetch.go`, `internal/crawl/errors.go`. Unchanged: `progress.go`, `internal/crawl/links.go`, `normalize.go`, `result.go`, `set.go`, and `cmd/testsite`.

```bash
go get golang.org/x/time/rate@v0.16.0 golang.org/x/sync/errgroup@v0.23.0
```

`go get` records both modules in `go.mod` and their checksums in `go.sum`.

```text title="go.mod"
module example.com/linkcheck

go 1.27

require (
	golang.org/x/net v0.59.0
	golang.org/x/sync v0.23.0
	golang.org/x/time v0.16.0
)
```

```go title="internal/crawl/limit.go"
package crawl

import (
	"context"
	"sync"

	"golang.org/x/time/rate"
)

// HostLimiter limits the request rate to each host separately, so a crawl
// that touches many sites is not slowed down by the limit on one of them.
// The zero value is not usable; set Limit.
type HostLimiter struct {
	Limit rate.Limit // requests per second to one host; rate.Inf for no limit
	Burst int        // requests allowed at once before the limit applies; at least 1

	mu    sync.Mutex
	hosts map[string]*rate.Limiter
}

// Wait blocks until a request to host is allowed or ctx is done.
func (h *HostLimiter) Wait(ctx context.Context, host string) error {
	return h.limiter(host).Wait(ctx)
}

// limiter returns the limiter for host, creating it on first use.
func (h *HostLimiter) limiter(host string) *rate.Limiter {
	h.mu.Lock()
	defer h.mu.Unlock()
	l, ok := h.hosts[host]
	if !ok {
		if h.hosts == nil {
			h.hosts = make(map[string]*rate.Limiter)
		}
		l = rate.NewLimiter(h.Limit, max(h.Burst, 1))
		h.hosts[host] = l
	}
	return l
}
```

The mutex guards only the map lookup, not the `Wait`. Holding the lock while one worker waits for its slot on host A would make every other worker wait to even look up host B. `rate.Limiter` is safe for concurrent use on its own, so it needs no lock of ours.

`Burst: 1` means "no bursts": with `-rate 2/s`, requests to one host start at least half a second apart. A larger burst lets that many go at once after an idle spell.

```go title="internal/crawl/fetch.go"
package crawl

import (
	"context"
	"io"
	"mime"
	"net/http"
)

// maxBody is the most bytes of an HTML page that Fetch reads.
const maxBody = 5 << 20

// Page is the result of fetching one URL.
type Page struct {
	URL         string // the final URL, after redirects
	Status      int
	ContentType string
	Body        []byte // only set for HTML pages
}

// HTML reports whether the page is an HTML document.
func (p *Page) HTML() bool {
	mt, _, err := mime.ParseMediaType(p.ContentType)
	return err == nil && mt == "text/html"
}

// HTTPFetcher fetches pages over HTTP.
type HTTPFetcher struct {
	Client    *http.Client
	UserAgent string // sent with every request when not empty
}

// Fetch sends a GET request for rawURL. It returns an error only when no
// response arrives; an HTTP error status is reported in Page.Status.
func (f *HTTPFetcher) Fetch(ctx context.Context, rawURL string) (*Page, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return nil, err
	}
	if f.UserAgent != "" {
		req.Header.Set("User-Agent", f.UserAgent)
	}
	resp, err := f.Client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	p := &Page{
		URL:         resp.Request.URL.String(),
		Status:      resp.StatusCode,
		ContentType: resp.Header.Get("Content-Type"),
	}
	if p.HTML() {
		p.Body, err = io.ReadAll(io.LimitReader(resp.Body, maxBody))
		if err != nil {
			return nil, err
		}
	} else {
		// Drain the body so the connection can be reused.
		_, _ = io.Copy(io.Discard, resp.Body)
	}
	return p, nil
}
```

```go title="internal/crawl/errors.go"
package crawl

import (
	"errors"
	"fmt"
	"net/http"
)

// ErrBadStatus is wrapped by a LinkError whose server answered with an
// HTTP error status (400 or above).
var ErrBadStatus = errors.New("bad HTTP status")

// ErrTimeout is wrapped by a LinkError whose request took longer than the
// crawler's Timeout.
var ErrTimeout = errors.New("timed out")

// LinkError describes a link that could not be followed.
type LinkError struct {
	URL    string
	Status int   // the HTTP status, or 0 if no response arrived
	Err    error // ErrBadStatus, or the network error
}

func (e *LinkError) Error() string {
	if e.Status != 0 {
		return fmt.Sprintf("%s: %d %s", e.URL, e.Status, http.StatusText(e.Status))
	}
	return fmt.Sprintf("%s: %v", e.URL, e.Err)
}

func (e *LinkError) Unwrap() error {
	return e.Err
}
```

```go title="internal/crawl/crawler.go"
package crawl

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/url"
	"sync"
	"sync/atomic"
	"time"
)

// Crawler checks every link on a site, following links on the start URLs'
// hosts up to MaxDepth clicks away. Links to other hosts are checked but
// not followed.
type Crawler struct {
	Fetcher  *HTTPFetcher
	MaxDepth int
	Workers  int           // how many URLs to check at once; at least 1
	Logger   *slog.Logger  // nil means no logging
	Limiter  *HostLimiter  // nil means no rate limit
	Timeout  time.Duration // for one request, body included; 0 means none

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

// Run crawls from the start URLs and returns one Result per distinct URL,
// in the order the checks finished. The start URLs come first in the
// results only if they finish first; they have Depth 0 and no Parent.
//
// If ctx is cancelled, Run stops starting new checks, waits for its
// workers to exit, and returns the results gathered so far together with
// ctx.Err().
func (c *Crawler) Run(ctx context.Context, starts ...string) ([]Result, error) {
	var hosts, visited Set[string]
	var queue []job
	for _, start := range starts {
		u, err := url.Parse(start)
		if err != nil {
			return nil, err
		}
		first, err := Normalize(u, "")
		if err != nil {
			return nil, fmt.Errorf("%s: %w", start, err)
		}
		hosts.Add(u.Host)
		if visited.Add(first) {
			queue = append(queue, job{url: first})
		}
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
				// hosts is never written after this point, so the
				// workers may read it concurrently.
				res, links := c.visit(ctx, j, &hosts)
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

// visit checks one URL. If the URL is an HTML page on one of the start
// hosts and is not too deep, it also returns the links on the page.
func (c *Crawler) visit(ctx context.Context, j job, hosts *Set[string]) (Result, []string) {
	res := Result{URL: j.url, Parent: j.parent, Depth: j.depth}
	u, err := url.Parse(j.url)
	if err != nil {
		res.Err = &LinkError{URL: j.url, Err: err}
		return res, nil
	}
	if c.Limiter != nil {
		if err := c.Limiter.Wait(ctx, u.Host); err != nil {
			res.Err = &LinkError{URL: j.url, Err: err}
			return res, nil
		}
	}

	fetchCtx := ctx
	if c.Timeout > 0 {
		var cancel context.CancelFunc
		fetchCtx, cancel = context.WithTimeout(ctx, c.Timeout)
		defer cancel()
	}
	begin := time.Now()
	page, err := c.Fetcher.Fetch(fetchCtx, j.url)
	res.Duration = time.Since(begin)
	if err != nil {
		// The client wraps its errors in *url.Error, which repeats the
		// method and URL; keep only the cause.
		if ue, ok := errors.AsType[*url.Error](err); ok {
			err = ue.Err
		}
		// Our own deadline expired, not the caller's: say so plainly.
		if errors.Is(err, context.DeadlineExceeded) && ctx.Err() == nil {
			err = fmt.Errorf("%w after %v", ErrTimeout, c.Timeout)
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
	if err != nil || !hosts.Has(final.Host) || !page.HTML() || j.depth >= c.MaxDepth {
		return res, nil
	}
	links, err := Links(final, bytes.NewReader(page.Body))
	if err != nil {
		return res, nil // a page that does not parse still loaded fine
	}
	return res, links
}
```

Three changes in `visit`:

1. It waits for the host's limiter before the request. `Wait` returns early with an error if the crawl is cancelled while it waits, so Ctrl-C still works when ten workers are queued behind the limit.
2. The request gets a child context with its own deadline. Cancelling the parent (Ctrl-C) still cancels the child; the child's deadline does not touch the parent. `defer cancel()` releases the timer as soon as `visit` returns, whether or not the deadline fired.
3. `context.DeadlineExceeded` alone does not say whose deadline it was. If the parent `ctx` is still alive, it was ours, so the error becomes `ErrTimeout`, wrapped with `%w` so `errors.Is(err, crawl.ErrTimeout)` works for callers.

The host set is filled before the workers start and only read after, so the workers share it without a lock. Writing to it from a worker would need one.

```go title="flags.go"
package main

import (
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"golang.org/x/time/rate"
)

// rateFlag is a request rate written as "N/PERIOD": "10/s", "30/m",
// "1/500ms". A bare number means per second, and "0" means no limit.
// It implements flag.Value.
type rateFlag struct {
	n   int
	per time.Duration
}

func (r *rateFlag) String() string {
	if r.n == 0 {
		return "0"
	}
	switch r.per {
	case time.Second:
		return fmt.Sprintf("%d/s", r.n)
	case time.Minute:
		return fmt.Sprintf("%d/m", r.n)
	}
	return fmt.Sprintf("%d/%v", r.n, r.per)
}

func (r *rateFlag) Set(s string) error {
	count, period, found := strings.Cut(s, "/")
	n, err := strconv.Atoi(count)
	if err != nil || n < 0 {
		return errors.New("want N/PERIOD, such as 10/s, 30/m or 1/500ms")
	}
	per := time.Second
	if found {
		switch period {
		case "s":
		case "m":
			per = time.Minute
		default:
			per, err = time.ParseDuration(period)
			if err != nil || per <= 0 {
				return fmt.Errorf("bad period %q: want s, m or a duration such as 500ms", period)
			}
		}
	}
	r.n, r.per = n, per
	return nil
}

// Limit converts the flag to a rate.Limit in events per second.
func (r *rateFlag) Limit() rate.Limit {
	if r.n == 0 {
		return rate.Inf
	}
	return rate.Limit(float64(r.n) / r.per.Seconds())
}
```

`flag.Var` takes any value with `String` and `Set` methods. `Set` runs once per occurrence on the command line, and its error becomes the "invalid value" message. `PrintDefaults` calls `String` on a zero `rateFlag` to decide whether to print a default, so `String` must work on the zero value.

```go title="preflight.go"
package main

import (
	"context"
	"fmt"
	"net"
	"net/url"
	"time"

	"golang.org/x/sync/errgroup"
)

// checkTCP opens and closes a TCP connection to the host of every start
// URL, all at once, and returns the first failure. It tells "the site is
// down" apart from "the site has broken links" before any crawling starts.
func checkTCP(ctx context.Context, starts []string, timeout time.Duration) error {
	g, ctx := errgroup.WithContext(ctx)
	for _, start := range starts {
		u, err := url.Parse(start)
		if err != nil {
			return err
		}
		port := u.Port()
		if port == "" {
			port = "80"
			if u.Scheme == "https" {
				port = "443"
			}
		}
		addr := net.JoinHostPort(u.Hostname(), port)
		g.Go(func() error {
			d := net.Dialer{Timeout: timeout}
			conn, err := d.DialContext(ctx, "tcp", addr)
			if err != nil {
				return fmt.Errorf("check-tcp: %w", err)
			}
			return conn.Close()
		})
	}
	return g.Wait()
}
```

`errgroup.WithContext` returns a context that is cancelled as soon as one dial fails, so the remaining dials stop early. `g.Wait` returns the first error.

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
	"time"

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
	starts    []string
	depth     int
	workers   int
	verbose   bool
	rate      rateFlag
	timeout   time.Duration
	checkTCP  bool
	userAgent string
}

func main() {
	cfg := config{rate: rateFlag{n: 10, per: time.Second}}
	flag.IntVar(&cfg.depth, "depth", 3, "follow links up to `n` clicks from the start page")
	flag.IntVar(&cfg.workers, "workers", 8, "check up to `n` links at once")
	flag.BoolVar(&cfg.verbose, "v", false, "log every check to stderr")
	flag.Var(&cfg.rate, "rate", "at most `N/PERIOD` requests to each host, such as 10/s or 30/m; 0 for no limit")
	flag.DurationVar(&cfg.timeout, "timeout", 10*time.Second, "give up on a request after `d`")
	flag.BoolVar(&cfg.checkTCP, "check-tcp", false, "connect to each start host before crawling")
	flag.StringVar(&cfg.userAgent, "user-agent", "linkcheck/dev", "User-Agent header to send")
	flag.Usage = func() {
		fmt.Fprintln(flag.CommandLine.Output(), "usage: linkcheck [flags] URL...")
		flag.PrintDefaults()
	}
	flag.Parse()
	if flag.NArg() == 0 {
		flag.Usage()
		os.Exit(exitError)
	}
	cfg.starts = flag.Args()

	// The first Ctrl-C cancels ctx; stop restores the default behaviour,
	// so a second Ctrl-C kills the process at once.
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	code := run(ctx, cfg, os.Stdout, os.Stderr)
	stop()
	os.Exit(code)
}

func run(ctx context.Context, cfg config, stdout, stderr io.Writer) int {
	level := slog.LevelWarn
	if cfg.verbose {
		level = slog.LevelDebug
	}
	logger := slog.New(slog.NewTextHandler(stderr, &slog.HandlerOptions{Level: level}))

	if cfg.checkTCP {
		if err := checkTCP(ctx, cfg.starts, cfg.timeout); err != nil {
			fmt.Fprintf(stderr, "linkcheck: %v\n", err)
			return exitError
		}
	}

	c := &crawl.Crawler{
		Fetcher: &crawl.HTTPFetcher{
			Client:    &http.Client{},
			UserAgent: cfg.userAgent,
		},
		MaxDepth: cfg.depth,
		Workers:  cfg.workers,
		Logger:   logger,
		Limiter:  &crawl.HostLimiter{Limit: cfg.rate.Limit(), Burst: 1},
		Timeout:  cfg.timeout,
	}
	stopProgress := func() {}
	if cfg.verbose {
		stopProgress = logProgress(logger, c)
	}
	results, err := c.Run(ctx, cfg.starts...)
	stopProgress()
	interrupted := errors.Is(err, context.Canceled)
	if err != nil && !interrupted {
		fmt.Fprintf(stderr, "linkcheck: %v\n", err)
		return exitError
	}
	if len(results) == 0 {
		fmt.Fprintln(stderr, "linkcheck: interrupted before a start page loaded")
		return exitInterrupted
	}
	for _, r := range results {
		if r.Depth == 0 && r.Err != nil {
			fmt.Fprintf(stderr, "linkcheck: start page: %v\n", r.Err)
			return exitError
		}
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

## Run it

With the testsite running, give `/slow` one second:

```bash
go build .
./linkcheck -timeout 1s http://127.0.0.1:8080/; echo "exit $?"
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
ERR  http://127.0.0.1:8080/slow
     on http://127.0.0.1:8080/
     timed out after 1s
404  http://127.0.0.1:8080/team.html
     on http://127.0.0.1:8080/old-page
404  http://127.0.0.1:8081/gone
     on http://127.0.0.1:8080/
ERR  http://127.0.0.1:8099/
     on http://127.0.0.1:8080/
     dial tcp 127.0.0.1:8099: connectex: No connection could be made because the target machine actively refused it.
ERR  https://127.0.0.1:8081/ok.html
     on http://127.0.0.1:8080/blog/post-2.html
     http: server gave HTTP response to HTTPS client
17 links checked, 9 broken
exit 1
```

The run took 1.65 seconds instead of more than three, and `/slow` is now broken: a page that takes longer than your limit is broken for your readers too. The test site saw the cancellation: its `/slow` handler returned through `r.Context().Done()`.

Slow the crawl to two requests per second per host and watch when each check finishes:

```bash
./linkcheck -v -depth 1 -rate 2/s -timeout 1s http://127.0.0.1:8080/ > /dev/null
```

```text
time=2026-10-03T14:33:36.686+05:30 level=DEBUG msg=checked url=http://127.0.0.1:8080/ status=200 depth=0 took=2ms
time=2026-10-03T14:33:36.688+05:30 level=DEBUG msg=checked url=http://127.0.0.1:8081/gone status=404 depth=1 took=1ms
time=2026-10-03T14:33:36.688+05:30 level=DEBUG msg=checked url=http://127.0.0.1:8099/ status=0 depth=1 took=0s
time=2026-10-03T14:33:37.187+05:30 level=DEBUG msg=checked url=http://127.0.0.1:8080/old-page status=200 depth=1 took=3ms
time=2026-10-03T14:33:37.187+05:30 level=DEBUG msg=checked url=http://127.0.0.1:8081/ok.html status=200 depth=1 took=0s
time=2026-10-03T14:33:37.684+05:30 level=INFO msg=progress checked=5 broken=2
time=2026-10-03T14:33:37.685+05:30 level=DEBUG msg=checked url=http://127.0.0.1:8080/about.html status=200 depth=1 took=1ms
time=2026-10-03T14:33:38.184+05:30 level=DEBUG msg=checked url=http://127.0.0.1:8080/blog/ status=200 depth=1 took=0s
time=2026-10-03T14:33:38.684+05:30 level=INFO msg=progress checked=7 broken=2
time=2026-10-03T14:33:38.685+05:30 level=DEBUG msg=checked url=http://127.0.0.1:8080/missing.html status=404 depth=1 took=1ms
time=2026-10-03T14:33:39.684+05:30 level=INFO msg=progress checked=8 broken=3
time=2026-10-03T14:33:39.685+05:30 level=DEBUG msg=checked url=http://127.0.0.1:8080/error status=500 depth=1 took=1ms
time=2026-10-03T14:33:40.185+05:30 level=DEBUG msg=checked url=http://127.0.0.1:8080/slow status=0 depth=1 took=1s
```

Read the `checked` timestamps per host. Port 8080 gets one request every 500 ms: `36.686`, `37.187`, `37.685`, `38.184`, `38.685`. The gap before `/error` is a full second because the slot at `39.18` went to `/slow`, which started then and timed out a second later, at `40.185`. Ports 8081 and 8099 have their own limiters, so their links went at once and did not wait behind 8080. The order of URLs within a host varies between runs; the spacing does not.

Check the hosts before crawling. Any host that refuses connections stops the run with status 2:

```bash
./linkcheck -check-tcp http://127.0.0.1:8099/ http://127.0.0.1:8080/; echo "exit $?"
```

```text
linkcheck: check-tcp: dial tcp 127.0.0.1:8099: connectex: No connection could be made because the target machine actively refused it.
exit 2
```

Two reachable start URLs, checked only (depth 0):

```bash
./linkcheck -check-tcp -depth 0 http://127.0.0.1:8080/ http://127.0.0.1:8081/ok.html; echo "exit $?"
```

```text
2 links checked, 0 broken
exit 0
```

A bad flag value is rejected by `Set`, and the flag package prints the usage:

```bash
./linkcheck -rate fast http://127.0.0.1:8080/; echo "exit $?"
```

```text
invalid value "fast" for flag -rate: want N/PERIOD, such as 10/s, 30/m or 1/500ms
usage: linkcheck [flags] URL...
  -check-tcp
    	connect to each start host before crawling
  -depth n
    	follow links up to n clicks from the start page (default 3)
  -rate N/PERIOD
    	at most N/PERIOD requests to each host, such as 10/s or 30/m; 0 for no limit (default 10/s)
  -timeout d
    	give up on a request after d (default 10s)
  -user-agent string
    	User-Agent header to send (default "linkcheck/dev")
  -v	log every check to stderr
  -workers n
    	check up to n links at once (default 8)
exit 2
```

The flag package exits with status 2 on a parse error, the same code linkcheck uses for "could not run".

> [!WARNING]
> Dropping the cancel function, as in `fetchCtx, _ := context.WithTimeout(ctx, c.Timeout)`, compiles and seems to work, but every request leaves a timer and a context alive until its deadline passes. On a crawl of thousands of links that is thousands of live timers. `go vet` catches it: `the cancel function returned by context.WithTimeout should be called, not discarded, to avoid a context leak`. Always `defer cancel()`.

The crawl reports everything it finds, including links you know about and do not care about. [[step-5-filters]] adds filters and a config file.
