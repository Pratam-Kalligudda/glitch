---
title: "Step 8: save and resume"
done_when: "A crawl run with `-state crawl.json.gz` and interrupted with Ctrl-C writes the file and exits with 130; running the same command again prints `resuming run ...`, fetches only the pending URLs, reports `17 links checked, 8 broken, 0 excluded`, deletes the file, and lists `about.html` and `about-print.html` under `same content`."
---
linkcheck now saves an interrupted crawl as gzipped JSON and resumes it on the next run, gives every crawl a UUID that travels with each request in its context, and reports pages whose content is byte-for-byte identical by comparing SHA-256 hashes.

Do this yourself first, then compare.

1. Split `Run` into `Resume(ctx, *State)`: track in-flight jobs in a map keyed by URL, and on cancellation return them plus the queue as `Pending` ([[maps]], [[context]]).
2. Rebuild the visited set from a saved state, so a resumed crawl never fetches a finished URL again ([[generic-types]]).
3. Hash each HTML page on a start host with `crypto/sha256` and store it as hex; skip redirected pages ([[crypto-hash]], [[base64-hex]]).
4. Generate a run ID with `uuid.NewV7` (the `uuid` package is new in Go 1.27), and carry it in the context with an unexported key type ([[crypto-rand]], [[context-values]]).
5. Send the run ID as a request header from `HTTPFetcher`, and add it to every log line with `slog.Logger.With` ([[http-client]], [[slog]]).
6. Write the state as JSON through a `gzip.Writer` into a temporary file, close both in the right order, then rename the file into place ([[compress]], [[json]], [[os-files]], [[filepath-fs]]).
7. Load it back, and treat a missing file as "start fresh" with `errors.Is(err, fs.ErrNotExist)` ([[is-as]], [[filepath-fs]]).
8. Report duplicate pages in the text, JSON and HTML formats, and update the golden files ([[golden-files]], [[writing-iterators]]).

## The code

New: `internal/crawl/runid.go`, `internal/state/state.go`, `internal/state/state_test.go`. Changed: `main.go`; in `internal/crawl`, `crawler.go`, `fetch.go`, `result.go`, `crawler_test.go`, `fetch_test.go`; in `internal/report`, `report.go`, `text.go`, `json.go`, `report.html.tmpl`, `report_test.go` and all five golden files. Unchanged: `go.mod` (`uuid` is in the standard library), `go.sum`, `main_test.go`, `flags.go`, `config.go`, `preflight.go`, `progress.go`, `serve.go`, `linkcheck.json`, `internal/report/csv.go`, `junit.go`, `html.go`, the other `internal/crawl` files, and `cmd/testsite`.

### Resumable crawls

```go title="internal/crawl/crawler.go"
package crawl

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"maps"
	"net/url"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// A Fetcher fetches one URL. *HTTPFetcher is the real one; tests use
// fakes. Fetch returns an error only when no response arrives.
type Fetcher interface {
	Fetch(ctx context.Context, rawURL string) (*Page, error)
}

// Crawler checks every link on a site, following links on the start URLs'
// hosts up to MaxDepth clicks away. Links to other hosts are checked but
// not followed.
type Crawler struct {
	Fetcher  Fetcher
	MaxDepth int
	Workers  int           // how many URLs to check at once; at least 1
	Logger   *slog.Logger  // nil means no logging
	Limiter  *HostLimiter  // nil means no rate limit
	Timeout  time.Duration // for one request, body included; 0 means none
	Filter   Filter        // which links to check; start URLs always are

	checked atomic.Int64 // URLs checked so far; read with Progress
	broken  atomic.Int64 // how many of those were broken
}

// Job is a URL waiting to be checked.
type Job struct {
	URL    string `json:"url"`
	Parent string `json:"parent,omitzero"`
	Depth  int    `json:"depth"`
}

// State is a crawl that can be stopped and resumed: its start URLs, the
// results so far, and the jobs that were queued or in flight when it
// stopped.
type State struct {
	Starts  []string
	Results []Result
	Pending []Job
}

// done is what a worker sends back after visiting a job.
type done struct {
	res   Result
	links []string
}

// Run crawls from the start URLs and returns one Result per distinct URL,
// in the order the checks finished. The start URLs have Depth 0 and no
// Parent.
//
// If ctx is cancelled, Run stops starting new checks, waits for its
// workers to exit, and returns the results gathered so far together with
// ctx.Err().
func (c *Crawler) Run(ctx context.Context, starts ...string) ([]Result, error) {
	st, err := c.Resume(ctx, &State{Starts: starts})
	if st == nil {
		return nil, err
	}
	return st.Results, err
}

// Resume continues the crawl described by st and returns its new state. A
// State with no Results and no Pending jobs starts from st.Starts.
//
// When ctx is cancelled, Resume returns the state so far with ctx.Err();
// its Pending jobs are exactly the work that is left, so passing it to
// Resume later finishes the crawl. st itself is not modified.
func (c *Crawler) Resume(ctx context.Context, st *State) (*State, error) {
	var hosts, visited Set[string]
	var queue []Job
	fresh := len(st.Results) == 0 && len(st.Pending) == 0
	for _, start := range st.Starts {
		u, err := url.Parse(start)
		if err != nil {
			return nil, err
		}
		first, err := Normalize(u, "")
		if err != nil {
			return nil, fmt.Errorf("%s: %w", start, err)
		}
		hosts.Add(u.Host)
		if fresh && visited.Add(first) {
			queue = append(queue, Job{URL: first})
		}
	}
	results := slices.Clone(st.Results)
	for _, r := range results {
		visited.Add(r.URL)
	}
	for _, j := range st.Pending {
		if visited.Add(j.URL) {
			queue = append(queue, j)
		}
	}
	log := c.Logger
	if log == nil {
		log = slog.New(slog.DiscardHandler)
	}

	jobs := make(chan Job)
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

	// inFlight holds the jobs a worker has taken but not reported back.
	inFlight := make(map[string]Job)

loop:
	for len(queue) > 0 || len(inFlight) > 0 {
		// A nil channel blocks forever, so with an empty queue the send
		// case is switched off and select waits for results only.
		var send chan Job
		var next Job
		if len(queue) > 0 {
			send, next = jobs, queue[0]
		}
		select {
		case send <- next:
			queue = queue[1:]
			inFlight[next.URL] = next
		case d := <-finished:
			if ctx.Err() != nil {
				break loop // the check may have been cut short; it stays pending
			}
			delete(inFlight, d.res.URL)
			results = append(results, d.res)
			log.Debug("checked", "url", d.res.URL, "status", d.res.Status,
				"depth", d.res.Depth, "took", d.res.Duration.Round(time.Millisecond))
			for _, link := range d.links {
				if !visited.Add(link) {
					continue
				}
				if !c.Filter.Allow(link) {
					results = append(results, Result{
						URL: link, Parent: d.res.URL, Depth: d.res.Depth + 1, Excluded: true,
					})
					continue
				}
				queue = append(queue, Job{URL: link, Parent: d.res.URL, Depth: d.res.Depth + 1})
			}
		case <-ctx.Done():
			break loop
		}
	}

	close(jobs)
	wg.Wait()
	out := &State{Starts: st.Starts, Results: results}
	if err := ctx.Err(); err != nil {
		// Unfinished work first, in a stable order, then the queue.
		byURL := func(a, b Job) int { return strings.Compare(a.URL, b.URL) }
		out.Pending = append(slices.SortedFunc(maps.Values(inFlight), byURL), queue...)
		log.Warn("crawl stopped", "checked", len(results), "queued", len(queue), "in_flight", len(inFlight))
		return out, err
	}
	return out, nil
}

// Progress reports how many URLs the workers have checked so far and how
// many of those were broken. It is safe to call from any goroutine while
// Run is running.
func (c *Crawler) Progress() (checked, broken int64) {
	return c.checked.Load(), c.broken.Load()
}

// visit checks one URL. If the URL is an HTML page on one of the start
// hosts, it records a hash of the page, and if the page is not too deep
// it also returns the links on it.
func (c *Crawler) visit(ctx context.Context, j Job, hosts *Set[string]) (Result, []string) {
	res := Result{URL: j.URL, Parent: j.Parent, Depth: j.Depth}
	u, err := url.Parse(j.URL)
	if err != nil {
		res.Err = &LinkError{URL: j.URL, Err: err}
		return res, nil
	}
	if c.Limiter != nil {
		if err := c.Limiter.Wait(ctx, u.Host); err != nil {
			res.Err = &LinkError{URL: j.URL, Err: err}
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
	page, err := c.Fetcher.Fetch(fetchCtx, j.URL)
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
		res.Err = &LinkError{URL: j.URL, Err: err}
		return res, nil
	}
	res.Status = page.Status
	if page.Status >= 400 {
		res.Err = &LinkError{URL: j.URL, Status: page.Status, Err: ErrBadStatus}
		return res, nil
	}

	final, err := url.Parse(page.URL)
	if err != nil || !hosts.Has(final.Host) || !page.HTML() {
		return res, nil
	}
	// A redirect serves another URL's content; only hash pages served at
	// their own address, so a redirect is not reported as a duplicate.
	if page.URL == j.URL {
		sum := sha256.Sum256(page.Body)
		res.Hash = hex.EncodeToString(sum[:])
	}
	if j.Depth >= c.MaxDepth {
		return res, nil
	}
	links, err := Links(final, bytes.NewReader(page.Body))
	if err != nil {
		return res, nil // a page that does not parse still loaded fine
	}
	return res, links
}
```

What changed in the crawler:

- `job` became the exported `Job` with JSON tags, because pending jobs are now saved to disk by another package.
- `inFlight` went from a count to a map from URL to job. On Ctrl-C the coordinator knows exactly which jobs a worker had taken, and they go back into `Pending`. A result that arrives after cancellation is dropped *before* its job leaves the map, so a check cut short is retried on resume rather than lost.
- `Resume` rebuilds `visited` from the saved results and pending jobs. A link to a page that was finished in the first run is recognised and not fetched again.
- `Run` keeps its signature by calling `Resume` with a fresh state, so the tests from step 6 and `main_test.go` still pass untouched.
- `visit` hashes every HTML page on a start host, even at the depth limit, but only when the page answered at its own URL. `/old-page` redirects to `about.html`, and two URLs serving the same page through a redirect are not a duplicate worth reporting.

`sha256.Sum256` returns a `[32]byte` array; `sum[:]` slices it so `hex.EncodeToString` can take it. Hex doubles the size but gives a string that is safe in JSON, in HTML and in a terminal.

```go title="internal/crawl/runid.go"
package crawl

import "context"

// runIDKey is the context key for the run ID. An unexported struct type
// cannot collide with a key from any other package.
type runIDKey struct{}

// WithRunID returns a copy of ctx that carries the ID of the current
// crawl. HTTPFetcher sends it with every request as X-Linkcheck-Run, so a
// site owner can find one crawl in their access logs.
func WithRunID(ctx context.Context, id string) context.Context {
	return context.WithValue(ctx, runIDKey{}, id)
}

// RunID returns the run ID stored in ctx, or "" if there is none.
func RunID(ctx context.Context) string {
	id, _ := ctx.Value(runIDKey{}).(string)
	return id
}
```

The key is a value of an unexported empty struct type. No other package can create a value of type `runIDKey`, so no other package can read or overwrite this entry by accident, which a string key such as `"run"` would allow. `RunID` uses the two-value type assertion, so a context without the key returns `""` instead of panicking.

The run ID is the right kind of context value: it describes the request ("which crawl sent this"), it crosses an API boundary (from `main` through the crawler into the fetcher), and no function's behaviour depends on it. The timeout and the rate limit stay explicit fields; hiding them in the context would make the crawler's behaviour depend on invisible inputs.

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
	if id := RunID(ctx); id != "" {
		req.Header.Set("X-Linkcheck-Run", id)
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

```go title="internal/crawl/result.go"
package crawl

import (
	"strings"
	"time"
)

// Outcome classifies a checked link.
type Outcome int

const (
	OK       Outcome = iota // the link works
	Broken                  // the link returned an error status or no response
	Excluded                // a filter skipped the link; it was not requested
)

func (o Outcome) String() string {
	switch o {
	case OK:
		return "ok"
	case Broken:
		return "broken"
	case Excluded:
		return "excluded"
	}
	return "unknown"
}

// MarshalText makes an Outcome appear as "ok", "broken" or "excluded" in
// JSON and XML instead of as a number.
func (o Outcome) MarshalText() ([]byte, error) {
	return []byte(o.String()), nil
}

// Result is what the crawler learned about one URL.
type Result struct {
	URL      string
	Parent   string // the page the link was first found on; "" for a start URL
	Depth    int    // clicks from the start URL
	Status   int    // HTTP status, or 0 if no response arrived
	Err      error  // a *LinkError when the link is broken
	Excluded bool   // a filter skipped the link
	Hash     string // SHA-256 of an HTML page on a start host, in hex; else ""

	Duration time.Duration // how long the request took
}

// Outcome reports whether the link works.
func (r Result) Outcome() Outcome {
	switch {
	case r.Excluded:
		return Excluded
	case r.Err != nil:
		return Broken
	}
	return OK
}

// Compare orders results by URL. It returns -1, 0 or +1, like
// strings.Compare.
func (r Result) Compare(other Result) int {
	return strings.Compare(r.URL, other.URL)
}
```

```go title="internal/crawl/crawler_test.go"
package crawl

import (
	"context"
	"errors"
	"fmt"
	"maps"
	"regexp"
	"slices"
	"sync"
	"testing"
	"testing/synctest"
	"time"

	"golang.org/x/time/rate"
)

// fakePage is one page of a fake site.
type fakePage struct {
	status int           // 0 means 200
	html   string        // served as text/html
	delay  time.Duration // how long the "server" takes to answer
}

// fakeFetcher serves a fake site from memory. URLs not in pages are 404.
// It records how often each URL is fetched.
type fakeFetcher struct {
	pages map[string]fakePage

	mu    sync.Mutex
	calls map[string]int
}

func (f *fakeFetcher) Fetch(ctx context.Context, rawURL string) (*Page, error) {
	f.mu.Lock()
	f.calls[rawURL]++
	f.mu.Unlock()

	p, ok := f.pages[rawURL]
	if !ok {
		return &Page{URL: rawURL, Status: 404, ContentType: "text/plain"}, nil
	}
	if p.delay > 0 {
		select {
		case <-time.After(p.delay):
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	status := p.status
	if status == 0 {
		status = 200
	}
	return &Page{URL: rawURL, Status: status, ContentType: "text/html; charset=utf-8", Body: []byte(p.html)}, nil
}

// newFake returns a fake fetcher for pages. It fails the test at cleanup
// if any URL was fetched more than once.
func newFake(t *testing.T, pages map[string]fakePage) *fakeFetcher {
	t.Helper()
	f := &fakeFetcher{pages: pages, calls: make(map[string]int)}
	t.Cleanup(func() {
		for u, n := range f.calls {
			if n > 1 {
				t.Errorf("%s fetched %d times, want once", u, n)
			}
		}
	})
	return f
}

// byURL indexes results by URL.
func byURL(results []Result) map[string]Result {
	m := make(map[string]Result, len(results))
	for _, r := range results {
		m[r.URL] = r
	}
	return m
}

// site is a small fake site used by several tests: a home page, two
// levels below it, a 404, an external link and a cycle back home.
var site = map[string]fakePage{
	"http://site.test/": {html: `
		<a href="/a.html">a</a>
		<a href="/missing.html">missing</a>
		<a href="https://other.test/x">external</a>`},
	"http://site.test/a.html": {html: `
		<a href="/">home</a>
		<a href="/b.html">b</a>`},
	"http://site.test/b.html": {html: `<a href="/c.html">c</a>`},
	"http://site.test/c.html": {html: `<p>the end</p>`},
	"https://other.test/x":    {html: `<a href="https://other.test/never-followed">n</a>`},
}

func TestCrawlerReportsEveryLinkOnce(t *testing.T) {
	c := &Crawler{Fetcher: newFake(t, site), MaxDepth: 10, Workers: 4}
	results, err := c.Run(t.Context(), "http://site.test/")
	if err != nil {
		t.Fatal(err)
	}
	got := byURL(results)

	want := map[string]Outcome{
		"http://site.test/":             OK,
		"http://site.test/a.html":       OK,
		"http://site.test/b.html":       OK,
		"http://site.test/c.html":       OK,
		"http://site.test/missing.html": Broken,
		"https://other.test/x":          OK,
	}
	if !slices.Equal(slices.Sorted(maps.Keys(got)), slices.Sorted(maps.Keys(want))) {
		t.Fatalf("checked %q, want %q", slices.Sorted(maps.Keys(got)), slices.Sorted(maps.Keys(want)))
	}
	for u, outcome := range want {
		if got[u].Outcome() != outcome {
			t.Errorf("%s: outcome %v, want %v", u, got[u].Outcome(), outcome)
		}
	}

	missing := got["http://site.test/missing.html"]
	if missing.Parent != "http://site.test/" || missing.Depth != 1 {
		t.Errorf("missing.html: parent %q depth %d, want home page and 1", missing.Parent, missing.Depth)
	}
	le, ok := errors.AsType[*LinkError](missing.Err)
	if !ok || le.Status != 404 || !errors.Is(missing.Err, ErrBadStatus) {
		t.Errorf("missing.html: err = %#v, want *LinkError with 404 wrapping ErrBadStatus", missing.Err)
	}
}

func TestCrawlerMaxDepth(t *testing.T) {
	tests := []struct {
		depth int
		want  int // number of URLs checked
	}{
		{0, 1}, // the start page only
		{1, 4}, // plus a.html, missing.html, other.test/x
		{2, 5}, // plus b.html
		{3, 6}, // plus c.html
		{9, 6}, // nothing deeper exists
	}
	for _, tt := range tests {
		t.Run(fmt.Sprintf("depth=%d", tt.depth), func(t *testing.T) {
			c := &Crawler{Fetcher: newFake(t, site), MaxDepth: tt.depth, Workers: 2}
			results, err := c.Run(t.Context(), "http://site.test/")
			if err != nil {
				t.Fatal(err)
			}
			if len(results) != tt.want {
				t.Errorf("depth %d: %d results, want %d", tt.depth, len(results), tt.want)
			}
		})
	}
}

func TestCrawlerFilter(t *testing.T) {
	f := newFake(t, site)
	c := &Crawler{
		Fetcher:  f,
		MaxDepth: 10,
		Filter:   Filter{Exclude: []*regexp.Regexp{regexp.MustCompile(`other\.test|b\.html`)}},
	}
	results, err := c.Run(t.Context(), "http://site.test/")
	if err != nil {
		t.Fatal(err)
	}
	got := byURL(results)
	for _, u := range []string{"https://other.test/x", "http://site.test/b.html"} {
		if got[u].Outcome() != Excluded {
			t.Errorf("%s: outcome %v, want excluded", u, got[u].Outcome())
		}
		if f.calls[u] != 0 {
			t.Errorf("%s was fetched", u)
		}
	}
	if _, ok := got["http://site.test/c.html"]; ok {
		t.Error("c.html is only linked from the excluded b.html but was checked")
	}
}

// The next tests run in a synctest bubble: time is fake, so a three-second
// page costs no real time, and durations are exact.

func TestCrawlerTimeout(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		f := newFake(t, map[string]fakePage{
			"http://site.test/":     {html: `<a href="/slow">slow</a>`},
			"http://site.test/slow": {delay: 3 * time.Second},
		})
		c := &Crawler{Fetcher: f, MaxDepth: 1, Timeout: time.Second}

		start := time.Now()
		results, err := c.Run(t.Context(), "http://site.test/")
		if err != nil {
			t.Fatal(err)
		}
		if elapsed := time.Since(start); elapsed != time.Second {
			t.Errorf("crawl took %v, want exactly 1s", elapsed)
		}
		slow := byURL(results)["http://site.test/slow"]
		if !errors.Is(slow.Err, ErrTimeout) {
			t.Errorf("slow: err = %v, want ErrTimeout", slow.Err)
		}
	})
}

func TestCrawlerRateLimit(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		f := newFake(t, map[string]fakePage{
			"http://site.test/":  {html: `<a href="/1">1</a><a href="/2">2</a><a href="/3">3</a><a href="/4">4</a>`},
			"http://site.test/1": {}, "http://site.test/2": {},
			"http://site.test/3": {}, "http://site.test/4": {},
		})
		c := &Crawler{
			Fetcher:  f,
			MaxDepth: 1,
			Workers:  8,
			Limiter:  &HostLimiter{Limit: rate.Limit(2), Burst: 1}, // 2 per second
		}

		start := time.Now()
		if _, err := c.Run(t.Context(), "http://site.test/"); err != nil {
			t.Fatal(err)
		}
		// Five requests, the first at once and then one every 500ms.
		if elapsed := time.Since(start); elapsed != 2*time.Second {
			t.Errorf("crawl took %v, want exactly 2s", elapsed)
		}
	})
}

func TestCrawlerCancelReturnsPartialResults(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		f := newFake(t, map[string]fakePage{
			"http://site.test/":     {html: `<a href="/fast">f</a><a href="/slow">s</a>`},
			"http://site.test/fast": {},
			"http://site.test/slow": {delay: time.Hour},
		})
		c := &Crawler{Fetcher: f, MaxDepth: 1, Workers: 4}

		ctx, cancel := context.WithCancel(t.Context())
		time.AfterFunc(time.Minute, cancel) // "Ctrl-C" a minute in

		results, err := c.Run(ctx, "http://site.test/")
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("err = %v, want context.Canceled", err)
		}
		got := byURL(results)
		if len(got) != 2 || got["http://site.test/fast"].Outcome() != OK {
			t.Errorf("results = %v, want the home page and /fast", slices.Sorted(maps.Keys(got)))
		}
		// A worker left blocked by Run could never wake up. Instead of
		// hanging, synctest reports it: "deadlock: all goroutines in
		// bubble are blocked".
	})
}

func TestCrawlerProgressWhileRunning(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		f := newFake(t, map[string]fakePage{
			"http://site.test/":     {html: `<a href="/fast">f</a><a href="/gone">g</a><a href="/slow">s</a>`},
			"http://site.test/fast": {},
			"http://site.test/slow": {delay: time.Minute},
		})
		c := &Crawler{Fetcher: f, MaxDepth: 1, Workers: 4}
		go c.Run(t.Context(), "http://site.test/")

		// Read the counters from this goroutine while Run's workers are
		// still writing them. /slow is in flight for another 59 seconds.
		time.Sleep(time.Second)
		checked, broken := c.Progress()
		if checked != 3 || broken != 1 {
			t.Errorf("Progress() = %d, %d; want 3 checked, 1 broken", checked, broken)
		}
		time.Sleep(time.Minute)
		if checked, _ := c.Progress(); checked != 4 {
			t.Errorf("after /slow: checked = %d, want 4", checked)
		}
	})
}

func TestResumeFinishesAnInterruptedCrawl(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		pages := map[string]fakePage{
			"http://site.test/":     {html: `<a href="/fast">f</a><a href="/slow">s</a>`},
			"http://site.test/fast": {},
			"http://site.test/slow": {html: `<a href="/after-slow">a</a>`, delay: time.Hour},
		}
		c := &Crawler{MaxDepth: 5, Workers: 4}

		// First run: cancelled while /slow is loading.
		c.Fetcher = newFake(t, pages)
		ctx, cancel := context.WithCancel(t.Context())
		time.AfterFunc(time.Minute, cancel)
		st, err := c.Resume(ctx, &State{Starts: []string{"http://site.test/"}})
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("err = %v, want context.Canceled", err)
		}
		if len(st.Results) != 2 || len(st.Pending) != 1 || st.Pending[0].URL != "http://site.test/slow" {
			t.Fatalf("after cancel: %d results, pending %v; want 2 results and /slow pending", len(st.Results), st.Pending)
		}

		// Second run: a fresh fetcher, so each URL may be fetched once
		// more. Only /slow and what it links to are fetched.
		f := newFake(t, pages)
		c.Fetcher = f
		st, err = c.Resume(t.Context(), st)
		if err != nil {
			t.Fatal(err)
		}
		got := slices.Sorted(maps.Keys(byURL(st.Results)))
		want := []string{"http://site.test/", "http://site.test/after-slow", "http://site.test/fast", "http://site.test/slow"}
		if !slices.Equal(got, want) || len(st.Pending) != 0 {
			t.Errorf("after resume: results %q, pending %v; want %q and nothing pending", got, st.Pending, want)
		}
		if f.calls["http://site.test/"] != 0 || f.calls["http://site.test/fast"] != 0 {
			t.Errorf("resume fetched pages that were already done: %v", f.calls)
		}
	})
}

func TestIdenticalPagesHaveTheSameHash(t *testing.T) {
	same := `<p>same content</p>`
	c := &Crawler{MaxDepth: 2, Fetcher: newFake(t, map[string]fakePage{
		"http://site.test/":   {html: `<a href="/a">a</a><a href="/b">b</a><a href="https://other.test/">o</a>`},
		"http://site.test/a":  {html: same},
		"http://site.test/b":  {html: same},
		"https://other.test/": {html: same},
	})}
	results, err := c.Run(t.Context(), "http://site.test/")
	if err != nil {
		t.Fatal(err)
	}
	got := byURL(results)
	a, b := got["http://site.test/a"].Hash, got["http://site.test/b"].Hash
	if a == "" || a != b {
		t.Errorf("hashes of identical pages: %q and %q, want equal and non-empty", a, b)
	}
	if a == got["http://site.test/"].Hash {
		t.Error("different pages have the same hash")
	}
	if h := got["https://other.test/"].Hash; h != "" {
		t.Errorf("external page hashed: %q", h)
	}
}
```

The resume test runs inside a synctest bubble, so the one-hour page and the one-minute "Ctrl-C" take no real time. It gives the second run a fresh fake fetcher and checks that the home page and `/fast` were not fetched again.

```go title="internal/crawl/fetch_test.go"
package crawl

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/synctest"
	"time"
)

// newTestServer serves a few fixed responses over httptest's in-memory
// network. Every request, whatever its host, reaches this handler.
func newTestServer(t *testing.T) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("/page", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Write([]byte(`<a href="/next">ua=` + r.UserAgent() + `</a>`))
	})
	mux.HandleFunc("/run", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		w.Write([]byte(r.Header.Get("X-Linkcheck-Run")))
	})
	mux.HandleFunc("/image.png", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "image/png")
		w.Write([]byte(strings.Repeat("x", 1000)))
	})
	mux.HandleFunc("/moved", func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "/page", http.StatusFound)
	})
	mux.HandleFunc("/slow", func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-time.After(time.Hour):
		case <-r.Context().Done():
		}
	})
	return httptest.NewTestServer(t, mux)
}

func TestHTTPFetcher(t *testing.T) {
	srv := newTestServer(t)
	f := &HTTPFetcher{Client: srv.Client(), UserAgent: "linkcheck-test"}

	tests := []struct {
		url        string
		wantURL    string
		wantStatus int
		wantBody   string
	}{
		{"http://site.test/page", "http://site.test/page", 200, `<a href="/next">ua=linkcheck-test</a>`},
		{"http://site.test/image.png", "http://site.test/image.png", 200, ""}, // not HTML: body not kept
		{"http://site.test/moved", "http://site.test/page", 200, `<a href="/next">ua=linkcheck-test</a>`},
		{"http://site.test/nope", "http://site.test/nope", 404, ""},
	}
	for _, tt := range tests {
		t.Run(tt.url, func(t *testing.T) {
			p, err := f.Fetch(t.Context(), tt.url)
			if err != nil {
				t.Fatal(err)
			}
			if p.URL != tt.wantURL || p.Status != tt.wantStatus || string(p.Body) != tt.wantBody {
				t.Errorf("got URL %q status %d body %q\nwant URL %q status %d body %q",
					p.URL, p.Status, p.Body, tt.wantURL, tt.wantStatus, tt.wantBody)
			}
		})
	}
}

// The real HTTP stack over the in-memory network runs inside a synctest
// bubble, so the one-hour handler and the five-second timeout cost no
// real time.
func TestCrawlerTimeoutOverHTTP(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		srv := newTestServer(t)
		c := &Crawler{
			Fetcher: &HTTPFetcher{Client: srv.Client()},
			Timeout: 5 * time.Second,
		}
		start := time.Now()
		results, err := c.Run(t.Context(), "http://site.test/slow")
		if err != nil {
			t.Fatal(err)
		}
		if elapsed := time.Since(start); elapsed != 5*time.Second {
			t.Errorf("took %v, want exactly 5s", elapsed)
		}
		if !errors.Is(results[0].Err, ErrTimeout) {
			t.Errorf("err = %v, want ErrTimeout", results[0].Err)
		}
	})
}

func TestHTTPFetcherSendsRunID(t *testing.T) {
	srv := newTestServer(t)
	f := &HTTPFetcher{Client: srv.Client()}
	ctx := WithRunID(t.Context(), "run-42")
	p, err := f.Fetch(ctx, "http://site.test/run")
	if err != nil {
		t.Fatal(err)
	}
	if string(p.Body) != "run-42" {
		t.Errorf("server saw X-Linkcheck-Run %q, want %q", p.Body, "run-42")
	}
}
```

### The state file

```go title="internal/state/state.go"
// Package state saves an interrupted crawl to a gzipped JSON file and
// loads it again, so the crawl can be resumed.
package state

import (
	"compress/gzip"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"
	"uuid"

	"example.com/linkcheck/internal/crawl"
)

// version changes whenever the file format does, so an old file is
// rejected instead of being misread.
const version = 1

// file is the JSON written to disk.
type file struct {
	Version int         `json:"version"`
	RunID   uuid.UUID   `json:"run_id"` // a string, through UUID.MarshalText
	Saved   time.Time   `json:"saved"`
	Starts  []string    `json:"starts"`
	Results []result    `json:"results"`
	Pending []crawl.Job `json:"pending"`
}

// result is a crawl.Result with its error flattened to text: an error
// value cannot be encoded, only its message.
type result struct {
	URL        string `json:"url"`
	Parent     string `json:"parent,omitzero"`
	Depth      int    `json:"depth"`
	Status     int    `json:"status,omitzero"`
	Error      string `json:"error,omitzero"` // the cause, without the URL
	Excluded   bool   `json:"excluded,omitzero"`
	Hash       string `json:"sha256,omitzero"`
	DurationMS int64  `json:"duration_ms,omitzero"`
}

// Save writes st to path as gzipped JSON. It writes a temporary file in
// the same directory and renames it over path, so a crash in the middle of
// Save never leaves a half-written state file behind.
func Save(path string, runID uuid.UUID, st *crawl.State) (err error) {
	f := file{
		Version: version,
		RunID:   runID,
		Saved:   time.Now().UTC(),
		Starts:  st.Starts,
		Results: make([]result, 0, len(st.Results)),
		Pending: st.Pending,
	}
	for _, r := range st.Results {
		f.Results = append(f.Results, toFile(r))
	}

	tmp, err := os.CreateTemp(filepath.Dir(path), filepath.Base(path)+".*.tmp")
	if err != nil {
		return err
	}
	defer func() {
		if err != nil {
			tmp.Close()
			os.Remove(tmp.Name())
		}
	}()
	zw := gzip.NewWriter(tmp)
	if err := json.NewEncoder(zw).Encode(f); err != nil {
		return err
	}
	// Close the gzip writer first: it writes the compressed trailer to
	// the file. Then close the file.
	if err := zw.Close(); err != nil {
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), path)
}

// Load reads a state file written by Save. A missing file is reported
// with an error that matches fs.ErrNotExist.
func Load(path string) (uuid.UUID, *crawl.State, error) {
	fh, err := os.Open(path)
	if err != nil {
		return uuid.Nil(), nil, err
	}
	defer fh.Close()
	zr, err := gzip.NewReader(fh)
	if err != nil {
		return uuid.Nil(), nil, fmt.Errorf("%s: %w", path, err)
	}
	defer zr.Close()

	var f file
	if err := json.NewDecoder(zr).Decode(&f); err != nil {
		return uuid.Nil(), nil, fmt.Errorf("%s: %w", path, err)
	}
	if f.Version != version {
		return uuid.Nil(), nil, fmt.Errorf("%s: state file version %d, want %d", path, f.Version, version)
	}
	st := &crawl.State{Starts: f.Starts, Pending: f.Pending}
	for _, r := range f.Results {
		st.Results = append(st.Results, fromFile(r))
	}
	return f.RunID, st, nil
}

func toFile(r crawl.Result) result {
	out := result{
		URL:        r.URL,
		Parent:     r.Parent,
		Depth:      r.Depth,
		Status:     r.Status,
		Excluded:   r.Excluded,
		Hash:       r.Hash,
		DurationMS: r.Duration.Milliseconds(),
	}
	if le, ok := errors.AsType[*crawl.LinkError](r.Err); ok {
		out.Error = le.Err.Error()
	} else if r.Err != nil {
		out.Error = r.Err.Error()
	}
	return out
}

// fromFile rebuilds a Result. A bad status gets its sentinel back, so
// errors.Is(err, crawl.ErrBadStatus) still works after a resume; any other
// cause comes back as text only.
func fromFile(r result) crawl.Result {
	out := crawl.Result{
		URL:      r.URL,
		Parent:   r.Parent,
		Depth:    r.Depth,
		Status:   r.Status,
		Excluded: r.Excluded,
		Hash:     r.Hash,
		Duration: time.Duration(r.DurationMS) * time.Millisecond,
	}
	switch {
	case r.Status >= 400:
		out.Err = &crawl.LinkError{URL: r.URL, Status: r.Status, Err: crawl.ErrBadStatus}
	case r.Error != "":
		out.Err = &crawl.LinkError{URL: r.URL, Err: errors.New(r.Error)}
	}
	return out
}
```

How `Save` stays safe:

1. It writes to a temporary file in the same directory. `os.Rename` within one directory replaces the target in one step, so a reader sees either the old file or the new one, never half of one. A temporary file in another directory, such as `os.TempDir()`, could be on a different volume, where a rename fails.
2. The layers close inside out. `gzip.Writer.Close` writes the compressed trailer; closing the file first would cut the stream short and `Load` would fail with `unexpected EOF`.
3. The deferred function removes the temporary file on any error, using the named result `err` to know whether one happened.

An `error` is an interface value and cannot be decoded from JSON, so a result's error is stored as its message. `fromFile` gives a bad status its sentinel back, so `errors.Is(err, crawl.ErrBadStatus)` still holds after a resume; other causes, such as `ErrTimeout`, come back as text only. `uuid.UUID` implements `encoding.TextMarshaler`, so the run ID appears in the file as the usual `01a101fe-...` string, not as an array of 16 numbers.

```go title="internal/state/state_test.go"
package state

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"
	"uuid"

	"example.com/linkcheck/internal/crawl"
)

func TestSaveLoadRoundTrip(t *testing.T) {
	path := filepath.Join(t.TempDir(), "crawl.json.gz")
	id := uuid.NewV7()
	in := &crawl.State{
		Starts: []string{"http://site.test/"},
		Results: []crawl.Result{
			{URL: "http://site.test/", Status: 200, Hash: "abc", Duration: 12 * time.Millisecond},
			{URL: "http://site.test/gone", Parent: "http://site.test/", Depth: 1, Status: 404,
				Err: &crawl.LinkError{URL: "http://site.test/gone", Status: 404, Err: crawl.ErrBadStatus}},
			{URL: "http://down.test/", Parent: "http://site.test/", Depth: 1,
				Err: &crawl.LinkError{URL: "http://down.test/", Err: errors.New("connection refused")}},
			{URL: "http://other.test/", Parent: "http://site.test/", Depth: 1, Excluded: true},
		},
		Pending: []crawl.Job{{URL: "http://site.test/slow", Parent: "http://site.test/", Depth: 1}},
	}
	if err := Save(path, id, in); err != nil {
		t.Fatal(err)
	}
	gotID, out, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if gotID != id {
		t.Errorf("run ID %v, want %v", gotID, id)
	}
	if !reflect.DeepEqual(out.Starts, in.Starts) || !reflect.DeepEqual(out.Pending, in.Pending) {
		t.Errorf("starts/pending changed:\n got %v %v\nwant %v %v", out.Starts, out.Pending, in.Starts, in.Pending)
	}
	for i, want := range in.Results {
		got := out.Results[i]
		if got.URL != want.URL || got.Status != want.Status || got.Hash != want.Hash ||
			got.Duration != want.Duration || got.Outcome() != want.Outcome() {
			t.Errorf("result %d:\n got %+v\nwant %+v", i, got, want)
		}
		if (got.Err == nil) != (want.Err == nil) || (got.Err != nil && got.Err.Error() != want.Err.Error()) {
			t.Errorf("result %d: err %v, want %v", i, got.Err, want.Err)
		}
	}
	if !errors.Is(out.Results[1].Err, crawl.ErrBadStatus) {
		t.Error("a 404 lost its ErrBadStatus after the round trip")
	}

	// Save leaves no temporary files behind.
	entries, err := os.ReadDir(filepath.Dir(path))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 {
		t.Errorf("directory has %d files, want only the state file", len(entries))
	}
}

func TestLoadMissingFile(t *testing.T) {
	_, _, err := Load(filepath.Join(t.TempDir(), "nope.json.gz"))
	if !errors.Is(err, fs.ErrNotExist) {
		t.Errorf("err = %v, want fs.ErrNotExist", err)
	}
}

func TestLoadNotGzip(t *testing.T) {
	path := filepath.Join(t.TempDir(), "plain.json")
	if err := os.WriteFile(path, []byte(`{"version": 1}`), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, _, err := Load(path); err == nil {
		t.Error("loading a file that is not gzip succeeded")
	}
}
```

`t.TempDir` gives each test a directory that is deleted when the test ends, and the round-trip test also checks that `Save` left no temporary files behind.

### Reports

```go title="internal/report/report.go"
// Package report renders the results of a crawl as text, JSON, CSV,
// JUnit XML or HTML.
package report

import (
	"cmp"
	"errors"
	"fmt"
	"io"
	"iter"
	"maps"
	"slices"
	"strings"
	"time"

	"example.com/linkcheck/internal/crawl"
)

// Report is everything a reporter needs to describe one crawl.
type Report struct {
	RunID       string
	Starts      []string
	Started     time.Time
	Elapsed     time.Duration
	Interrupted bool // the crawl was stopped early; the results are partial
	Results     []crawl.Result
}

// A Reporter writes a report in one format.
type Reporter interface {
	Report(w io.Writer, r *Report) error
}

var reporters = map[string]Reporter{
	"text":  Text{},
	"json":  JSON{},
	"csv":   CSV{},
	"junit": JUnit{},
	"html":  HTML{},
}

// ByName returns the reporter for a format name such as "json".
func ByName(name string) (Reporter, error) {
	if r, ok := reporters[name]; ok {
		return r, nil
	}
	names := slices.Sorted(maps.Keys(reporters))
	return nil, fmt.Errorf("unknown format %q: want one of %s", name, strings.Join(names, ", "))
}

// Comparer is a type that can order its own values. The constraint
// mentions itself: T must have a method Compare(T) int.
type Comparer[T Comparer[T]] interface {
	Compare(T) int
}

// Sorted collects seq into a slice sorted by the values' own Compare
// method.
func Sorted[T Comparer[T]](seq iter.Seq[T]) []T {
	return slices.SortedFunc(seq, func(a, b T) int { return a.Compare(b) })
}

// Filter yields the values of seq for which keep returns true.
func Filter[T any](seq iter.Seq[T], keep func(T) bool) iter.Seq[T] {
	return func(yield func(T) bool) {
		for v := range seq {
			if keep(v) && !yield(v) {
				return
			}
		}
	}
}

// All yields every result, sorted by URL.
func (r *Report) All() iter.Seq[crawl.Result] {
	return slices.Values(Sorted(slices.Values(r.Results)))
}

// Broken yields the broken results, sorted by URL.
func (r *Report) Broken() iter.Seq[crawl.Result] {
	return Filter(r.All(), func(res crawl.Result) bool {
		return res.Outcome() == crawl.Broken
	})
}

// Duplicates yields each group of two or more URLs whose pages had
// identical content (the same SHA-256), sorted within the group, with the
// groups in order of their first URL.
func (r *Report) Duplicates() iter.Seq[[]string] {
	byHash := make(map[string][]string)
	for res := range r.All() {
		if res.Hash != "" {
			byHash[res.Hash] = append(byHash[res.Hash], res.URL)
		}
	}
	var groups [][]string
	for _, urls := range byHash {
		if len(urls) > 1 {
			groups = append(groups, urls)
		}
	}
	slices.SortFunc(groups, func(a, b []string) int { return strings.Compare(a[0], b[0]) })
	return slices.Values(groups)
}

// Count returns how many results have the outcome o.
func (r *Report) Count(o crawl.Outcome) int {
	n := 0
	for _, res := range r.Results {
		if res.Outcome() == o {
			n++
		}
	}
	return n
}

// Summary is the one-line count that ends every text report.
func (r *Report) Summary() string {
	excluded := r.Count(crawl.Excluded)
	return fmt.Sprintf("%d links checked, %d broken, %d excluded",
		len(r.Results)-excluded, r.Count(crawl.Broken), excluded)
}

// BrokenBy groups the broken results by key and yields the groups in key
// order, each sorted by URL. It is a generic method: K is chosen per call.
func (r *Report) BrokenBy[K cmp.Ordered](key func(crawl.Result) K) iter.Seq2[K, []crawl.Result] {
	groups := make(map[K][]crawl.Result)
	for res := range r.Broken() {
		k := key(res)
		groups[k] = append(groups[k], res)
	}
	return func(yield func(K, []crawl.Result) bool) {
		for _, k := range slices.Sorted(maps.Keys(groups)) {
			if !yield(k, groups[k]) {
				return
			}
		}
	}
}

// status is the HTTP status as text, "ERR" when no response arrived, or
// "-" for a link that was never requested.
func status(res crawl.Result) string {
	switch {
	case res.Outcome() == crawl.Excluded:
		return "-"
	case res.Status == 0:
		return "ERR"
	}
	return fmt.Sprint(res.Status)
}

// detail is the network error behind a broken link, or "" when the server
// answered with an error status (the status says it all).
func detail(res crawl.Result) string {
	le, ok := errors.AsType[*crawl.LinkError](res.Err)
	if !ok || errors.Is(le, crawl.ErrBadStatus) {
		return ""
	}
	return le.Err.Error()
}
```

```go title="internal/report/text.go"
package report

import (
	"bufio"
	"fmt"
	"io"

	"example.com/linkcheck/internal/crawl"
)

// Text writes the broken links grouped by the page they are on, then a
// summary line. It is the default format.
type Text struct{}

func (Text) Report(w io.Writer, r *Report) error {
	// bufio.Writer remembers the first write error and returns it from
	// Flush, so the Fprintf calls below need no error checks of their own.
	bw := bufio.NewWriter(w)
	for page, results := range r.BrokenBy(func(res crawl.Result) string { return res.Parent }) {
		if page == "" {
			page = "(start URLs)"
		}
		fmt.Fprintln(bw, page)
		for _, res := range results {
			fmt.Fprintf(bw, "  %-4s %s\n", status(res), res.URL)
			if d := detail(res); d != "" {
				fmt.Fprintf(bw, "       %s\n", d)
			}
		}
	}
	for urls := range r.Duplicates() {
		fmt.Fprintln(bw, "same content:")
		for _, u := range urls {
			fmt.Fprintf(bw, "  %s\n", u)
		}
	}
	fmt.Fprintln(bw, r.Summary())
	if r.Interrupted {
		fmt.Fprintln(bw, "interrupted: this report is partial")
	}
	return bw.Flush()
}
```

```go title="internal/report/json.go"
package report

import (
	"encoding/json"
	"io"
	"slices"
	"time"

	"example.com/linkcheck/internal/crawl"
)

// JSON writes the whole report as one indented JSON object.
type JSON struct{}

type jsonReport struct {
	RunID       string       `json:"run_id,omitzero"`
	Starts      []string     `json:"starts"`
	Started     time.Time    `json:"started"`
	ElapsedMS   int64        `json:"elapsed_ms"`
	Interrupted bool         `json:"interrupted,omitzero"`
	Checked     int          `json:"checked"`
	Broken      int          `json:"broken"`
	Excluded    int          `json:"excluded"`
	Results     []jsonResult `json:"results"`
	Duplicates  [][]string   `json:"duplicates,omitzero"`
}

type jsonResult struct {
	URL        string        `json:"url"`
	Parent     string        `json:"parent,omitzero"`
	Depth      int           `json:"depth"`
	Status     int           `json:"status,omitzero"`
	Outcome    crawl.Outcome `json:"outcome"` // a string, through MarshalText
	Error      string        `json:"error,omitzero"`
	DurationMS int64         `json:"duration_ms,omitzero"`
	Hash       string        `json:"sha256,omitzero"`
}

func (JSON) Report(w io.Writer, r *Report) error {
	out := jsonReport{
		RunID:       r.RunID,
		Starts:      r.Starts,
		Started:     r.Started,
		ElapsedMS:   r.Elapsed.Milliseconds(),
		Interrupted: r.Interrupted,
		Checked:     len(r.Results) - r.Count(crawl.Excluded),
		Broken:      r.Count(crawl.Broken),
		Excluded:    r.Count(crawl.Excluded),
		Results:     make([]jsonResult, 0, len(r.Results)),
	}
	for res := range r.All() {
		jr := jsonResult{
			URL:        res.URL,
			Parent:     res.Parent,
			Depth:      res.Depth,
			Status:     res.Status,
			Outcome:    res.Outcome(),
			DurationMS: res.Duration.Milliseconds(),
			Hash:       res.Hash,
		}
		if res.Err != nil {
			jr.Error = res.Err.Error()
		}
		out.Results = append(out.Results, jr)
	}
	out.Duplicates = slices.Collect(r.Duplicates())
	enc := json.NewEncoder(w)
	enc.SetIndent("", "  ")
	return enc.Encode(out)
}
```

```html title="internal/report/report.html.tmpl"
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>linkcheck report</title>
<style>
  body { font: 16px/1.5 system-ui, sans-serif; margin: 2rem auto; max-width: 70rem; padding: 0 1rem; }
  table { border-collapse: collapse; width: 100%; margin-bottom: 2rem; }
  th, td { text-align: left; padding: .25rem .5rem; border-bottom: 1px solid #ddd; vertical-align: top; }
  td { overflow-wrap: anywhere; }
  .broken { color: #b00020; }
  .excluded { color: #777; }
</style>
</head>
<body>
<h1>linkcheck report</h1>
<p>Started {{.Started.Format "2006-01-02 15:04:05 MST"}} from {{range $i, $s := .Starts}}{{if $i}}, {{end}}<a href="{{$s}}">{{$s}}</a>{{end}}.
{{.Summary}} in {{round .Elapsed}}.{{with .RunID}} Run {{.}}.{{end}}</p>
{{if .Interrupted}}<p class="broken"><strong>Interrupted: this report is partial.</strong></p>{{end}}

<h2>Broken links</h2>
<table>
<tr><th>Status</th><th>Link</th><th>Found on</th><th>Problem</th></tr>
{{range .Broken}}<tr class="broken">
  <td>{{status .}}</td>
  <td><a href="{{.URL}}">{{.URL}}</a></td>
  <td>{{with .Parent}}<a href="{{.}}">{{.}}</a>{{end}}</td>
  <td>{{detail .}}</td>
</tr>
{{else}}<tr><td colspan="4">None.</td></tr>
{{end}}</table>

{{range .Duplicates}}<h2>Same content</h2>
<ul>{{range .}}<li><a href="{{.}}">{{.}}</a></li>{{end}}</ul>
{{end}}
<h2>Every URL</h2>
<table>
<tr><th>Status</th><th>Outcome</th><th>URL</th><th>Depth</th><th>ms</th></tr>
{{range .All}}<tr class="{{.Outcome}}">
  <td>{{status .}}</td>
  <td>{{.Outcome}}</td>
  <td><a href="{{.URL}}">{{.URL}}</a></td>
  <td>{{.Depth}}</td>
  <td>{{ms .}}</td>
</tr>
{{end}}</table>
</body>
</html>
```

```go title="internal/report/report_test.go"
package report

import (
	"bytes"
	"errors"
	"flag"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"example.com/linkcheck/internal/crawl"
)

var update = flag.Bool("update", false, "rewrite the golden files in testdata")

// sample is a fixed report: every format is rendered from it and compared
// with a golden file.
func sample() *Report {
	home := "http://site.test/"
	return &Report{
		RunID:   "019a8f3c-5c2e-7d41-9b1a-3f2e8c7d6b5a",
		Starts:  []string{home},
		Started: time.Date(2026, 10, 3, 9, 30, 0, 0, time.UTC),
		Elapsed: 1250 * time.Millisecond,
		Results: []crawl.Result{
			{URL: home, Depth: 0, Status: 200, Duration: 12 * time.Millisecond, Hash: "aa11"},
			{URL: "http://site.test/missing.html", Parent: home, Depth: 1, Status: 404,
				Err:      &crawl.LinkError{URL: "http://site.test/missing.html", Status: 404, Err: crawl.ErrBadStatus},
				Duration: 3 * time.Millisecond},
			{URL: "http://down.test/", Parent: "http://site.test/about.html", Depth: 2,
				Err:      &crawl.LinkError{URL: "http://down.test/", Err: errors.New("connection refused")},
				Duration: 1 * time.Millisecond},
			{URL: "http://site.test/about.html", Parent: home, Depth: 1, Status: 200, Duration: 5 * time.Millisecond, Hash: "bb22"},
			{URL: "http://site.test/print.html", Parent: "http://site.test/about.html", Depth: 2, Status: 200, Duration: 4 * time.Millisecond, Hash: "bb22"},
			{URL: "http://other.test/<b>&\"x\"", Parent: home, Depth: 1, Excluded: true},
		},
	}
}

func TestGolden(t *testing.T) {
	for name, rep := range reporters {
		t.Run(name, func(t *testing.T) {
			var buf bytes.Buffer
			if err := rep.Report(&buf, sample()); err != nil {
				t.Fatal(err)
			}
			golden := filepath.Join("testdata", name+".golden")
			if *update {
				if err := os.WriteFile(golden, buf.Bytes(), 0o644); err != nil {
					t.Fatal(err)
				}
			}
			want, err := os.ReadFile(golden)
			if err != nil {
				t.Fatalf("%v (run go test -update to create it)", err)
			}
			if got := buf.String(); got != string(want) {
				t.Errorf("output differs from %s; run go test -update and review the diff\ngot:\n%s", golden, got)
			}
		})
	}
}

func TestHTMLEscapesURLs(t *testing.T) {
	r := &Report{Results: []crawl.Result{{
		URL:    `javascript:alert("hi")`,
		Status: 404,
		Err:    &crawl.LinkError{Status: 404, Err: crawl.ErrBadStatus},
	}}}
	var buf bytes.Buffer
	if err := (HTML{}).Report(&buf, r); err != nil {
		t.Fatal(err)
	}
	out := buf.String()
	if strings.Contains(out, `href="javascript:`) {
		t.Error("a javascript: URL reached an href attribute")
	}
	if !strings.Contains(out, `href="#ZgotmplZ"`) {
		t.Error("expected html/template to replace the unsafe URL with #ZgotmplZ")
	}
}

func TestByName(t *testing.T) {
	if _, err := ByName("json"); err != nil {
		t.Fatal(err)
	}
	_, err := ByName("yaml")
	want := `unknown format "yaml": want one of csv, html, json, junit, text`
	if err == nil || err.Error() != want {
		t.Errorf("ByName(yaml) error = %v, want %q", err, want)
	}
}

func TestBrokenByGroupsInKeyOrder(t *testing.T) {
	var depths []int
	for depth, results := range sample().BrokenBy(func(r crawl.Result) int { return r.Depth }) {
		depths = append(depths, depth)
		if len(results) != 1 {
			t.Errorf("depth %d: %d results, want 1", depth, len(results))
		}
	}
	if len(depths) != 2 || depths[0] != 1 || depths[1] != 2 {
		t.Errorf("depths = %v, want [1 2]", depths)
	}
}
```

The sample report gains a run ID and two pages with the same hash, so the golden files change. Regenerate them and review the difference before you commit:

```bash
go test ./internal/report -update
git diff internal/report/testdata
```

```text title="internal/report/testdata/text.golden"
http://site.test/
  404  http://site.test/missing.html
http://site.test/about.html
  ERR  http://down.test/
       connection refused
same content:
  http://site.test/about.html
  http://site.test/print.html
5 links checked, 2 broken, 1 excluded
```

```json title="internal/report/testdata/json.golden"
{
  "run_id": "019a8f3c-5c2e-7d41-9b1a-3f2e8c7d6b5a",
  "starts": [
    "http://site.test/"
  ],
  "started": "2026-10-03T09:30:00Z",
  "elapsed_ms": 1250,
  "checked": 5,
  "broken": 2,
  "excluded": 1,
  "results": [
    {
      "url": "http://down.test/",
      "parent": "http://site.test/about.html",
      "depth": 2,
      "outcome": "broken",
      "error": "http://down.test/: connection refused",
      "duration_ms": 1
    },
    {
      "url": "http://other.test/\u003cb\u003e\u0026\"x\"",
      "parent": "http://site.test/",
      "depth": 1,
      "outcome": "excluded"
    },
    {
      "url": "http://site.test/",
      "depth": 0,
      "status": 200,
      "outcome": "ok",
      "duration_ms": 12,
      "sha256": "aa11"
    },
    {
      "url": "http://site.test/about.html",
      "parent": "http://site.test/",
      "depth": 1,
      "status": 200,
      "outcome": "ok",
      "duration_ms": 5,
      "sha256": "bb22"
    },
    {
      "url": "http://site.test/missing.html",
      "parent": "http://site.test/",
      "depth": 1,
      "status": 404,
      "outcome": "broken",
      "error": "http://site.test/missing.html: 404 Not Found",
      "duration_ms": 3
    },
    {
      "url": "http://site.test/print.html",
      "parent": "http://site.test/about.html",
      "depth": 2,
      "status": 200,
      "outcome": "ok",
      "duration_ms": 4,
      "sha256": "bb22"
    }
  ],
  "duplicates": [
    [
      "http://site.test/about.html",
      "http://site.test/print.html"
    ]
  ]
}
```

```csv title="internal/report/testdata/csv.golden"
url,parent,depth,status,outcome,error,duration_ms
http://down.test/,http://site.test/about.html,2,0,broken,http://down.test/: connection refused,1
"http://other.test/<b>&""x""",http://site.test/,1,0,excluded,,0
http://site.test/,,0,200,ok,,12
http://site.test/about.html,http://site.test/,1,200,ok,,5
http://site.test/missing.html,http://site.test/,1,404,broken,http://site.test/missing.html: 404 Not Found,3
http://site.test/print.html,http://site.test/about.html,2,200,ok,,4
```

```xml title="internal/report/testdata/junit.golden"
<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
  <testsuite name="linkcheck" tests="6" failures="2" skipped="1" time="1.250" timestamp="2026-10-03T09:30:00Z">
    <testcase name="http://down.test/" classname="http://site.test/about.html" time="0.001">
      <failure message="ERR" type="broken">http://down.test/: connection refused</failure>
    </testcase>
    <testcase name="http://other.test/&lt;b&gt;&amp;&#34;x&#34;" classname="http://site.test/" time="0.000">
      <skipped></skipped>
    </testcase>
    <testcase name="http://site.test/" classname="" time="0.012"></testcase>
    <testcase name="http://site.test/about.html" classname="http://site.test/" time="0.005"></testcase>
    <testcase name="http://site.test/missing.html" classname="http://site.test/" time="0.003">
      <failure message="404" type="broken">http://site.test/missing.html: 404 Not Found</failure>
    </testcase>
    <testcase name="http://site.test/print.html" classname="http://site.test/about.html" time="0.004"></testcase>
  </testsuite>
</testsuites>
```

```html title="internal/report/testdata/html.golden"
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>linkcheck report</title>
<style>
  body { font: 16px/1.5 system-ui, sans-serif; margin: 2rem auto; max-width: 70rem; padding: 0 1rem; }
  table { border-collapse: collapse; width: 100%; margin-bottom: 2rem; }
  th, td { text-align: left; padding: .25rem .5rem; border-bottom: 1px solid #ddd; vertical-align: top; }
  td { overflow-wrap: anywhere; }
  .broken { color: #b00020; }
  .excluded { color: #777; }
</style>
</head>
<body>
<h1>linkcheck report</h1>
<p>Started 2026-10-03 09:30:00 UTC from <a href="http://site.test/">http://site.test/</a>.
5 links checked, 2 broken, 1 excluded in 1.25s. Run 019a8f3c-5c2e-7d41-9b1a-3f2e8c7d6b5a.</p>


<h2>Broken links</h2>
<table>
<tr><th>Status</th><th>Link</th><th>Found on</th><th>Problem</th></tr>
<tr class="broken">
  <td>ERR</td>
  <td><a href="http://down.test/">http://down.test/</a></td>
  <td><a href="http://site.test/about.html">http://site.test/about.html</a></td>
  <td>connection refused</td>
</tr>
<tr class="broken">
  <td>404</td>
  <td><a href="http://site.test/missing.html">http://site.test/missing.html</a></td>
  <td><a href="http://site.test/">http://site.test/</a></td>
  <td></td>
</tr>
</table>

<h2>Same content</h2>
<ul><li><a href="http://site.test/about.html">http://site.test/about.html</a></li><li><a href="http://site.test/print.html">http://site.test/print.html</a></li></ul>

<h2>Every URL</h2>
<table>
<tr><th>Status</th><th>Outcome</th><th>URL</th><th>Depth</th><th>ms</th></tr>
<tr class="broken">
  <td>ERR</td>
  <td>broken</td>
  <td><a href="http://down.test/">http://down.test/</a></td>
  <td>2</td>
  <td>1</td>
</tr>
<tr class="excluded">
  <td>-</td>
  <td>excluded</td>
  <td><a href="http://other.test/%3cb%3e&amp;%22x%22">http://other.test/&lt;b&gt;&amp;&#34;x&#34;</a></td>
  <td>1</td>
  <td>0</td>
</tr>
<tr class="ok">
  <td>200</td>
  <td>ok</td>
  <td><a href="http://site.test/">http://site.test/</a></td>
  <td>0</td>
  <td>12</td>
</tr>
<tr class="ok">
  <td>200</td>
  <td>ok</td>
  <td><a href="http://site.test/about.html">http://site.test/about.html</a></td>
  <td>1</td>
  <td>5</td>
</tr>
<tr class="broken">
  <td>404</td>
  <td>broken</td>
  <td><a href="http://site.test/missing.html">http://site.test/missing.html</a></td>
  <td>1</td>
  <td>3</td>
</tr>
<tr class="ok">
  <td>200</td>
  <td>ok</td>
  <td><a href="http://site.test/print.html">http://site.test/print.html</a></td>
  <td>2</td>
  <td>4</td>
</tr>
</table>
</body>
</html>
```

CSV and JUnit did not change in code; their golden files changed only because the sample has a new row.

### main

```go title="main.go"
// Command linkcheck crawls a website and reports broken links.
package main

import (
	"cmp"
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"time"
	"uuid"

	"example.com/linkcheck/internal/crawl"
	"example.com/linkcheck/internal/report"
	"example.com/linkcheck/internal/state"
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
	include   regexpList
	exclude   regexpList
	format    string
	out       string
	serve     string
	stateFile string
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
	flag.Var(&cfg.include, "include", "only check links matching `regexp` (repeatable)")
	flag.Var(&cfg.exclude, "exclude", "skip links matching `regexp` (repeatable)")
	flag.StringVar(&cfg.format, "format", "text", "report `format`: text, json, csv, junit or html")
	flag.StringVar(&cfg.out, "out", "", "write the report to `file` instead of stdout")
	flag.StringVar(&cfg.serve, "serve", "", "after the crawl, serve the HTML report on `addr`, such as 127.0.0.1:8090")
	flag.StringVar(&cfg.stateFile, "state", "", "resume from `file` if it exists; save to it when interrupted")
	configPath := flag.String("config", "", "read settings from the JSON `file`; flags win")
	flag.Usage = func() {
		fmt.Fprintln(flag.CommandLine.Output(), "usage: linkcheck [flags] URL...")
		flag.PrintDefaults()
	}
	flag.Parse()
	cfg.starts = flag.Args()
	if *configPath != "" {
		set := make(map[string]bool)
		flag.Visit(func(f *flag.Flag) { set[f.Name] = true })
		fc, err := loadConfig(*configPath)
		if err == nil {
			err = fc.apply(&cfg, set)
		}
		if err != nil {
			fmt.Fprintf(os.Stderr, "linkcheck: config: %v\n", err)
			os.Exit(exitError)
		}
	}
	if len(cfg.starts) == 0 {
		flag.Usage()
		os.Exit(exitError)
	}

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

	// cmp.Or returns its first non-zero argument: an empty format is text.
	reporter, err := report.ByName(cmp.Or(cfg.format, "text"))
	if err != nil {
		fmt.Fprintf(stderr, "linkcheck: %v\n", err)
		return exitError
	}

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
		Filter:   crawl.Filter{Include: cfg.include, Exclude: cfg.exclude},
	}
	// A version 7 UUID starts with a timestamp, so run IDs sort by the
	// time the crawl started.
	runID := uuid.NewV7()
	st := &crawl.State{Starts: cfg.starts}
	if cfg.stateFile != "" {
		id, saved, err := state.Load(cfg.stateFile)
		switch {
		case err == nil:
			runID, st = id, saved
			fmt.Fprintf(stderr, "resuming run %s: %d done, %d pending\n", runID, len(st.Results), len(st.Pending))
		case errors.Is(err, fs.ErrNotExist):
			// No saved crawl: start a new one.
		default:
			fmt.Fprintf(stderr, "linkcheck: %v\n", err)
			return exitError
		}
	}
	ctx = crawl.WithRunID(ctx, runID.String())
	c.Logger = logger.With("run", runID.String())

	stopProgress := func() {}
	if cfg.verbose {
		stopProgress = logProgress(logger, c)
	}
	started := time.Now()
	st, err = c.Resume(ctx, st)
	stopProgress()
	interrupted := errors.Is(err, context.Canceled)
	if err != nil && !interrupted {
		fmt.Fprintf(stderr, "linkcheck: %v\n", err)
		return exitError
	}
	results := st.Results
	if cfg.stateFile != "" {
		if err := saveOrClear(cfg.stateFile, runID, st, interrupted, stderr); err != nil {
			fmt.Fprintf(stderr, "linkcheck: state: %v\n", err)
			return exitError
		}
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

	rep := &report.Report{
		RunID:       runID.String(),
		Starts:      cfg.starts,
		Started:     started,
		Elapsed:     time.Since(started),
		Interrupted: interrupted,
		Results:     results,
	}
	if err := writeReport(reporter, rep, cfg.out, stdout); err != nil {
		fmt.Fprintf(stderr, "linkcheck: %v\n", err)
		return exitError
	}
	if cfg.serve != "" && !interrupted {
		if err := serveReport(ctx, cfg.serve, rep, stderr); err != nil {
			fmt.Fprintf(stderr, "linkcheck: serve: %v\n", err)
			return exitError
		}
	}

	switch {
	case interrupted:
		return exitInterrupted
	case rep.Count(crawl.Broken) > 0:
		return exitBroken
	}
	return exitOK
}

// writeReport writes the report to the file at path, or to stdout when
// path is empty.
func writeReport(reporter report.Reporter, rep *report.Report, path string, stdout io.Writer) (err error) {
	if path == "" {
		return reporter.Report(stdout, rep)
	}
	f, err := os.Create(path)
	if err != nil {
		return err
	}
	// A write error can surface only at Close, so its error must not be
	// dropped: keep it unless an earlier error is already being returned.
	defer func() {
		if cerr := f.Close(); err == nil {
			err = cerr
		}
	}()
	return reporter.Report(f, rep)
}

// saveOrClear saves an interrupted crawl to path, or removes path once the
// crawl is complete so the next run starts fresh.
func saveOrClear(path string, runID uuid.UUID, st *crawl.State, interrupted bool, stderr io.Writer) error {
	if !interrupted {
		if err := os.Remove(path); err != nil && !errors.Is(err, fs.ErrNotExist) {
			return err
		}
		return nil
	}
	if err := state.Save(path, runID, st); err != nil {
		return err
	}
	fmt.Fprintf(stderr, "saved run %s to %s: %d done, %d pending; run again with -state %s to resume\n",
		runID, path, len(st.Results), len(st.Pending), path)
	return nil
}
```

`runID` is created before the state is loaded and replaced if a saved run exists, so a resumed crawl keeps its original ID and the saved file, the logs and the report all agree on it. `c.Logger` is set after the crawler is built because the run ID is known only after the state file has been read.

## Run it

```bash
go test -count=1 ./...
```

```text
ok  	example.com/linkcheck	0.932s
?   	example.com/linkcheck/cmd/testsite	[no test files]
ok  	example.com/linkcheck/internal/crawl	1.762s
ok  	example.com/linkcheck/internal/report	0.874s
ok  	example.com/linkcheck/internal/state	1.014s
```

With the testsite running, start a crawl with a state file and press Ctrl-C about a second in, while `/slow` is loading:

```bash
go build .
./linkcheck -state crawl.json.gz http://127.0.0.1:8080/; echo "exit $?"
```

```text
time=2026-10-03T19:09:54.765+05:30 level=WARN msg="crawl stopped" run=01a101fe-1f29-7b8d-be13-e1fb6e56599e checked=13 queued=0 in_flight=3
saved run 01a101fe-1f29-7b8d-be13-e1fb6e56599e to crawl.json.gz: 13 done, 3 pending; run again with -state crawl.json.gz to resume
http://127.0.0.1:8080/
  500  http://127.0.0.1:8080/error
  404  http://127.0.0.1:8080/missing.html
  404  http://127.0.0.1:8081/gone
  ERR  http://127.0.0.1:8099/
       dial tcp 127.0.0.1:8099: connectex: No connection could be made because the target machine actively refused it.
http://127.0.0.1:8080/blog/post-2.html
  ERR  https://127.0.0.1:8081/ok.html
       http: server gave HTTP response to HTTPS client
http://127.0.0.1:8080/old-page
  404  http://127.0.0.1:8080/team.html
same content:
  http://127.0.0.1:8080/about-print.html
  http://127.0.0.1:8080/about.html
13 links checked, 6 broken, 0 excluded
interrupted: this report is partial
exit 130
```

The log line carries the run ID from `logger.With`. Three jobs were in flight: `/slow`, and two pages a worker had taken but that were still waiting for the 10-per-second rate limit when Ctrl-C arrived. The run ID differs on every run; a version 7 UUID starts with the time in milliseconds, so IDs from later runs sort after earlier ones.

The state file is small and is ordinary gzip:

```bash
ls -l crawl.json.gz
gzip -dc crawl.json.gz | wc -c
gzip -dc crawl.json.gz | grep -o '"pending":.*'
```

```text
-rw-r--r-- 1 Pratam 197121 681 Oct  3 19:09 crawl.json.gz
2404
"pending":[{"url":"http://127.0.0.1:8080/blog/drafts/","parent":"http://127.0.0.1:8080/blog/post-2.html","depth":3},{"url":"http://127.0.0.1:8080/blog/post-1.html","parent":"http://127.0.0.1:8080/blog/","depth":2},{"url":"http://127.0.0.1:8080/slow","parent":"http://127.0.0.1:8080/","depth":1}]}
```

2404 bytes of JSON compress to 681: URLs repeat, and repetition is what gzip removes.

Run the same command again:

```bash
./linkcheck -state crawl.json.gz http://127.0.0.1:8080/; echo "exit $?"
ls crawl.json.gz
```

```text
resuming run 01a101fe-1f29-7b8d-be13-e1fb6e56599e: 13 done, 3 pending
http://127.0.0.1:8080/
  500  http://127.0.0.1:8080/error
  404  http://127.0.0.1:8080/missing.html
  404  http://127.0.0.1:8081/gone
  ERR  http://127.0.0.1:8099/
       dial tcp 127.0.0.1:8099: connectex: No connection could be made because the target machine actively refused it.
http://127.0.0.1:8080/blog/post-1.html
  404  http://127.0.0.1:8080/blog/archive/2019.html
http://127.0.0.1:8080/blog/post-2.html
  404  http://127.0.0.1:8080/blog/drafts/
  ERR  https://127.0.0.1:8081/ok.html
       http: server gave HTTP response to HTTPS client
http://127.0.0.1:8080/old-page
  404  http://127.0.0.1:8080/team.html
same content:
  http://127.0.0.1:8080/about-print.html
  http://127.0.0.1:8080/about.html
17 links checked, 8 broken, 0 excluded
exit 1
ls: cannot access 'crawl.json.gz': No such file or directory
```

The resumed run kept the same run ID, fetched the three pending URLs and the one new link they led to (`archive/2019.html`, found on `post-1.html`), and produced the same 17 links and 8 broken ones as an uninterrupted crawl. The broken links from the first run, including the refused connection on port 8099, came back from the file. Once the crawl completed, the state file was removed so the next run starts fresh.

`same content` lists the two about pages, which the test site serves from identical files. `/old-page` serves the same bytes too, through a redirect, and is correctly left out.

> [!WARNING]
> `defer zw.Close()` followed by `return tmp.Close()` looks tidy and writes a corrupt file: the deferred gzip close runs after the file is already closed, the trailer is never written, and `Load` fails later with `unexpected EOF`. With buffered writers stacked on a file, close them yourself, innermost first, and check every error.

The tool is complete in features. [[step-9-profile]] measures where its time and memory go before it ships.
