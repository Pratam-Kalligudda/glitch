---
title: "Step 6: lock it with tests"
done_when: "`go test ./...` and `go test -race ./...` pass with no test server running, the synctest tests prove a 1s timeout and a 2-per-second rate limit to the exact duration in no real time, and `go test -fuzz FuzzNormalize -fuzztime 5m ./internal/crawl` finds nothing new."
---
linkcheck gets a test suite: the crawler now depends on a `Fetcher` interface so tests can use a fake site, and the suite covers link extraction, normalization, depth, filters, timeouts, rate limits, cancellation and leaks, the real HTTP fetcher, and the command's exit codes. A fuzz test finds four real bugs in `Normalize`, which this step fixes.

Do this yourself first, then compare.

1. Extract a one-method `Fetcher` interface where the crawler uses it, and keep `*HTTPFetcher` as the real implementation ([[implicit-interfaces]], [[accept-interfaces]]).
2. Write a fake fetcher that serves pages from a map and counts calls under a mutex ([[test-doubles]], [[mutexes]]).
3. Write table-driven tests with named subtests for `Normalize`, `Links`, depth limits, `rateFlag` and exit codes ([[table-tests]]).
4. Put repeated setup in helpers that call `t.Helper()` and check invariants in `t.Cleanup` ([[test-helpers]]).
5. Test the real `HTTPFetcher` against `httptest.NewTestServer` (Go 1.27) and `run` against a loopback server ([[httptest]]).
6. Run the timeout, rate-limit, cancellation and progress tests inside `synctest.Test`, so time is fake and exact and a leaked goroutine is reported as a deadlock ([[synctest]], [[goroutine-leaks]]).
7. Fuzz `Normalize` for idempotence, fix what it finds, and keep the failing inputs in `testdata/fuzz` ([[fuzzing]], [[golden-files]]).
8. Add `ExampleNormalize` with an `// Output:` comment ([[examples]]).
9. Run with `-cover` and `-race` ([[coverage-race]]).

## The code

New: `main_test.go`, `internal/crawl/normalize_test.go`, `example_test.go`, `links_test.go`, `crawler_test.go`, `fetch_test.go`, and four files under `internal/crawl/testdata/fuzz/FuzzNormalize/`. Changed: `internal/crawl/crawler.go` (the `Fetcher` interface), `internal/crawl/normalize.go` (the fuzz fixes). Unchanged: `go.mod`, `go.sum`, `main.go`, `flags.go`, `config.go`, `preflight.go`, `progress.go`, `linkcheck.json`, `internal/crawl/fetch.go`, `links.go`, `errors.go`, `result.go`, `set.go`, `limit.go`, `filter.go`, and `cmd/testsite`.

### The seam

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
				if !visited.Add(link) {
					continue
				}
				if !c.Filter.Allow(link) {
					results = append(results, Result{
						URL: link, Parent: d.res.URL, Depth: d.res.Depth + 1, Excluded: true,
					})
					continue
				}
				queue = append(queue, job{url: link, parent: d.res.URL, depth: d.res.Depth + 1})
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

The only change is the type of `Crawler.Fetcher`: an interface with the one method the crawler calls. `*HTTPFetcher` satisfies it without saying so, `main.go` does not change, and a test can now pass any type with a matching `Fetch` method. The interface lives in `crawl`, next to its consumer, and has exactly the methods the consumer needs.

### Normalize and its fuzz test

```go title="internal/crawl/normalize_test.go"
package crawl

import (
	"errors"
	"net/url"
	"testing"
)

func TestNormalize(t *testing.T) {
	base, err := url.Parse("http://example.com/blog/post.html")
	if err != nil {
		t.Fatal(err)
	}
	tests := []struct {
		name    string
		ref     string
		want    string
		wantErr error
	}{
		{"relative", "next.html", "http://example.com/blog/next.html", nil},
		{"parent dir", "../about.html", "http://example.com/about.html", nil},
		{"root", "/", "http://example.com/", nil},
		{"empty is the page itself", "", "http://example.com/blog/post.html", nil},
		{"fragment dropped", "next.html#comments", "http://example.com/blog/next.html", nil},
		{"fragment only", "#top", "http://example.com/blog/post.html", nil},
		{"host lower-cased", "http://EXAMPLE.com/a", "http://example.com/a", nil},
		{"scheme lower-cased", "HTTP://example.com/a", "http://example.com/a", nil},
		{"default http port dropped", "http://example.com:80/a", "http://example.com/a", nil},
		{"default https port dropped", "https://example.com:443/a", "https://example.com/a", nil},
		{"other port kept", "http://example.com:8080/a", "http://example.com:8080/a", nil},
		{"empty path becomes slash", "http://example.com", "http://example.com/", nil},
		{"query kept", "search?q=go", "http://example.com/blog/search?q=go", nil},
		{"spaces trimmed", "  next.html\n", "http://example.com/blog/next.html", nil},
		{"mailto rejected", "mailto:team@example.com", "", ErrScheme},
		{"javascript rejected", "javascript:void(0)", "", ErrScheme},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := Normalize(base, tt.ref)
			if !errors.Is(err, tt.wantErr) {
				t.Fatalf("Normalize(%q) error = %v, want %v", tt.ref, err, tt.wantErr)
			}
			if got != tt.want {
				t.Errorf("Normalize(%q) = %q, want %q", tt.ref, got, tt.want)
			}
		})
	}
}

// FuzzNormalize checks that normalizing is idempotent: a normalized URL
// normalizes to itself. If it did not, the visited set could hold two
// spellings of one page.
func FuzzNormalize(f *testing.F) {
	for _, seed := range []string{
		"next.html", "../a/./b/../c", "/", "#top", "?q=1",
		"HTTP://EXAMPLE.com:80", "https://example.com:443/x#y",
		"http://[::1]:80/", "//other.example/path", "mailto:x@example.com",
	} {
		f.Add(seed)
	}
	base, err := url.Parse("http://example.com/blog/post.html")
	if err != nil {
		f.Fatal(err)
	}
	f.Fuzz(func(t *testing.T, ref string) {
		once, err := Normalize(base, ref)
		if err != nil {
			return // rejecting input is fine; only accepted input must be stable
		}
		twice, err := Normalize(base, once)
		if err != nil {
			t.Fatalf("Normalize(%q) = %q, which then fails: %v", ref, once, err)
		}
		if once != twice {
			t.Fatalf("not idempotent:\n ref   %q\n once  %q\n twice %q", ref, once, twice)
		}
	})
}
```

The table test pins the behaviour you designed. The fuzz test checks a property for inputs nobody thought of: whatever `Normalize` returns must normalize to itself. If it did not, one page could enter the visited set under two spellings and be crawled twice.

Run the fuzzer against the step 5 version of `Normalize`:

```bash
go test -run '^$' -fuzz FuzzNormalize -fuzztime 60s ./internal/crawl
```

```text
fuzz: elapsed: 0s, gathering baseline coverage: 0/10 completed
fuzz: elapsed: 0s, gathering baseline coverage: 10/10 completed, now fuzzing with 12 workers
fuzz: elapsed: 1s, execs: 4088 (6152/sec), new interesting: 26 (total: 36)
--- FAIL: FuzzNormalize (0.67s)
    --- FAIL: FuzzNormalize (0.00s)
        normalize_test.go:72: Normalize("//::") = "http://::/", which then fails: parse "http://::/": invalid port "::" after host
    
    Failing input written to testdata\fuzz\FuzzNormalize\869c223b8b19cb36
    To re-run:
    go test -run=FuzzNormalize/869c223b8b19cb36
FAIL
exit status 1
FAIL	example.com/linkcheck/internal/crawl	1.610s
```

In under a second it found a link, `href="//::"`, that `Normalize` accepts and turns into a URL that does not parse. Resolving a reference against a base does not validate the host the way parsing an absolute URL does. Each fix and re-run found the next problem:

| Input | What went wrong | Fix |
|---|---|---|
| `//::` | Resolves to host `::`, which `url.Parse` rejects | Parse the result once more and return its error |
| `? #` | The query keeps a raw space; `TrimSpace` removes it on the second pass, so the two results differ | Escape spaces in the query as `%20` |
| `http: #` | An `http` URL with no host at all (`http: ` is opaque) | Reject an empty host or opaque URL with `ErrNoHost` |
| `//:80` | Has a host, `:80`, until the default port is stripped and nothing is left | Check for an empty host after stripping the port |

Each failing input was saved under `testdata/fuzz/FuzzNormalize`. Plain `go test` runs those files as ordinary test cases, so the four bugs stay fixed whether or not anyone fuzzes again:

```text title="internal/crawl/testdata/fuzz/FuzzNormalize/869c223b8b19cb36"
go test fuzz v1
string("//::")
```

The other three files have the same shape, with `string("? #")`, `string("http: #")` and `string("//:80")`. Commit them with the code.

```go title="internal/crawl/normalize.go"
package crawl

import (
	"errors"
	"net"
	"net/url"
	"strings"
)

// ErrScheme reports a link that is not http or https.
var ErrScheme = errors.New("not an http or https URL")

// ErrNoHost reports an http or https link without a host, such as "http:x".
var ErrNoHost = errors.New("URL has no host")

// Normalize resolves ref against base and returns it in a canonical form,
// so that two spellings of the same address compare equal: the host is
// lower case, a default port is removed, an empty path becomes "/", and
// the fragment is dropped.
//
// The result always parses again with url.Parse and normalizes to itself.
func Normalize(base *url.URL, ref string) (string, error) {
	u, err := base.Parse(strings.TrimSpace(ref))
	if err != nil {
		return "", err
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return "", ErrScheme
	}
	host := strings.ToLower(u.Host)
	if h, port, err := net.SplitHostPort(host); err == nil {
		if (u.Scheme == "http" && port == "80") || (u.Scheme == "https" && port == "443") {
			host = h
			if strings.Contains(h, ":") {
				host = "[" + h + "]" // an IPv6 address keeps its brackets
			}
		}
	}
	if host == "" || u.Opaque != "" {
		return "", ErrNoHost
	}
	u.Host = host
	if u.Path == "" {
		u.Path = "/"
	}
	u.Fragment = ""
	u.RawFragment = ""
	// url.Parse keeps a raw space in the query, and the TrimSpace above
	// would then eat it on the next round. Escape it as a browser does.
	u.RawQuery = strings.ReplaceAll(u.RawQuery, " ", "%20")

	// Resolving a reference does not validate the host the way parsing an
	// absolute URL does: "//::" resolves to the host "::". Parse the
	// result once more so a URL we cannot request again is rejected here.
	s := u.String()
	if _, err := url.Parse(s); err != nil {
		return "", err
	}
	return s, nil
}
```

After the four fixes, five minutes of fuzzing found nothing:

```bash
go test -run '^$' -fuzz FuzzNormalize -fuzztime 5m ./internal/crawl
```

```text
fuzz: elapsed: 4m54s, execs: 7057871 (23063/sec), new interesting: 59 (total: 490)
fuzz: elapsed: 4m57s, execs: 7120762 (21016/sec), new interesting: 59 (total: 490)
fuzz: elapsed: 5m0s, execs: 7182395 (20531/sec), new interesting: 60 (total: 491)
fuzz: elapsed: 5m1s, execs: 7182395 (0/sec), new interesting: 60 (total: 491)
PASS
ok  	example.com/linkcheck/internal/crawl	302.147s
```

The fuzzer is random: your run may find the bugs in a different order and with different execution counts.

```go title="internal/crawl/example_test.go"
package crawl_test

import (
	"fmt"
	"net/url"

	"example.com/linkcheck/internal/crawl"
)

func ExampleNormalize() {
	base, _ := url.Parse("http://example.com/blog/post.html")
	for _, ref := range []string{"next.html#comments", "HTTP://Example.COM:80", "mailto:me@example.com"} {
		u, err := crawl.Normalize(base, ref)
		fmt.Println(u, err)
	}
	// Output:
	// http://example.com/blog/next.html <nil>
	// http://example.com/ <nil>
	//  not an http or https URL
}
```

The example is in the external test package `crawl_test`, so it uses the package exactly as a caller would. `go test` runs it and compares its output with the `// Output:` comment, and `go doc` shows it next to `Normalize`. The third line starts with a space: `fmt.Println` prints the empty string, a space, then the error.

### Links

```go title="internal/crawl/links_test.go"
package crawl

import (
	"net/url"
	"slices"
	"strings"
	"testing"
)

func TestLinks(t *testing.T) {
	base, err := url.Parse("http://example.com/blog/")
	if err != nil {
		t.Fatal(err)
	}
	tests := []struct {
		name string
		html string
		want []string
	}{
		{
			name: "no links",
			html: `<p>nothing here</p>`,
			want: nil,
		},
		{
			name: "relative and absolute",
			html: `<a href="post.html">p</a> <a href="https://go.dev/doc/">go</a>`,
			want: []string{"http://example.com/blog/post.html", "https://go.dev/doc/"},
		},
		{
			name: "duplicates and fragments collapse",
			html: `<a href="a.html">1</a><a href="a.html#x">2</a><a href="A.html">3</a>`,
			want: []string{"http://example.com/blog/a.html", "http://example.com/blog/A.html"},
		},
		{
			name: "non-http schemes skipped",
			html: `<a href="mailto:x@example.com">m</a><a href="javascript:go()">j</a><a href="tel:123">t</a>`,
			want: nil,
		},
		{
			name: "anchors without href and other tags ignored",
			html: `<a name="top">t</a><link href="style.css"><img src="i.png">`,
			want: nil,
		},
		{
			name: "broken markup still parses",
			html: `<div><a href="x.html">unclosed <p><a href=y.html>y`,
			want: []string{"http://example.com/blog/x.html", "http://example.com/blog/y.html"},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := Links(base, strings.NewReader(tt.html))
			if err != nil {
				t.Fatal(err)
			}
			if !slices.Equal(got, tt.want) {
				t.Errorf("Links() =\n  %q\nwant\n  %q", got, tt.want)
			}
		})
	}
}
```

The last case is a parser property worth pinning: `html.Parse` repairs broken markup the way a browser does, so an unclosed tag or an unquoted attribute still yields its link.

### The crawler, with a fake site

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
```

How the crawler tests work:

- `fakeFetcher` answers from a map, so the tests need no network and no running test site. It counts calls under a mutex because the crawler's workers call it concurrently, and `newFake` registers a cleanup that fails the test if any URL was fetched twice.
- `TestCrawlerMaxDepth` runs one subtest per depth. A failure names the case, such as `TestCrawlerMaxDepth/depth=2`, and `go test -run 'TestCrawlerMaxDepth/depth=2'` re-runs only that one.
- The last four tests run inside `synctest.Test`. Inside the bubble the clock is fake and moves only when every goroutine is blocked, so a three-second page, a one-hour page and a one-minute "Ctrl-C" cost no real time, and the durations are exact: the rate-limit test asserts exactly two seconds for five requests at two per second, not "roughly".
- In the progress test, the test goroutine reads `Progress` while the workers are still writing the counters. That is the access `-race` checks below.

`TestCrawlerCancelReturnsPartialResults` also guards the leak you avoided in [[step-3-concurrent]]. Remove the `case <-ctx.Done(): return` from the worker and run it:

```text
--- FAIL: TestCrawlerCancelReturnsPartialResults (0.00s)
panic: deadlock: all goroutines in bubble are blocked [recovered, repanicked]
```

The stack trace that follows shows `Run` stuck in `sync.(*WaitGroup).Wait` and the worker stuck sending on `finished`. Without synctest the same mistake would hang the test until `go test` kills it after ten minutes.

### The real fetcher

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
```

`httptest.NewTestServer` (new in Go 1.27) runs the handler on an in-memory network. The client from `srv.Client()` sends every request to it whatever the host name, so the tests use readable URLs like `http://site.test/page`, and because there is no real socket the server works inside a synctest bubble: `TestCrawlerTimeoutOverHTTP` drives the real `net/http` client and server through a five-second timeout instantly.

### The command

```go title="main_test.go"
package main

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// startSite serves a three-page site on a loopback port. run builds its
// own http.Client, so this server must be reachable over the real network
// stack, not httptest's in-memory one.
func startSite(t *testing.T) string {
	t.Helper()
	mux := http.NewServeMux()
	page := func(body string) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "text/html")
			w.Write([]byte(body))
		}
	}
	mux.HandleFunc("/{$}", page(`<a href="/ok">ok</a> <a href="/broken">broken</a>`))
	mux.HandleFunc("/good", page(`<a href="/ok">ok</a>`))
	mux.HandleFunc("/ok", page(`fine`))
	srv := httptest.NewTestServer(t, mux)
	srv.Start()
	return srv.URL
}

func TestRunExitCodes(t *testing.T) {
	base := startSite(t)
	tests := []struct {
		name       string
		cfg        config
		wantCode   int
		wantStdout string // a line the output must contain
		wantStderr string
	}{
		{"all links work", config{starts: []string{base + "/good"}, depth: 1}, exitOK, "2 links checked, 0 broken, 0 excluded", ""},
		{"a broken link", config{starts: []string{base + "/"}, depth: 1}, exitBroken, "404  " + base + "/broken", ""},
		{"broken link excluded", config{starts: []string{base + "/"}, depth: 1, exclude: mustRegexps(t, "broken")}, exitOK, "2 links checked, 0 broken, 1 excluded", ""},
		{"start page missing", config{starts: []string{base + "/nothing"}, depth: 1}, exitError, "", "start page: " + base + "/nothing: 404 Not Found"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var stdout, stderr bytes.Buffer
			code := run(t.Context(), tt.cfg, &stdout, &stderr)
			if code != tt.wantCode {
				t.Errorf("exit code %d, want %d\nstdout:\n%s\nstderr:\n%s", code, tt.wantCode, &stdout, &stderr)
			}
			if !strings.Contains(stdout.String(), tt.wantStdout) {
				t.Errorf("stdout does not contain %q:\n%s", tt.wantStdout, &stdout)
			}
			if !strings.Contains(stderr.String(), tt.wantStderr) {
				t.Errorf("stderr does not contain %q:\n%s", tt.wantStderr, &stderr)
			}
		})
	}
}

func mustRegexps(t *testing.T, patterns ...string) regexpList {
	t.Helper()
	var l regexpList
	for _, p := range patterns {
		if err := l.Set(p); err != nil {
			t.Fatal(err)
		}
	}
	return l
}

func TestRateFlag(t *testing.T) {
	tests := []struct {
		in      string
		want    string
		wantErr bool
	}{
		{"10/s", "10/s", false},
		{"30/m", "30/m", false},
		{"1/500ms", "1/500ms", false},
		{"5", "5/s", false},
		{"0", "0", false},
		{"fast", "", true},
		{"-1/s", "", true},
		{"3/fortnight", "", true},
		{"3/0s", "", true},
	}
	for _, tt := range tests {
		t.Run(tt.in, func(t *testing.T) {
			var r rateFlag
			err := r.Set(tt.in)
			if (err != nil) != tt.wantErr {
				t.Fatalf("Set(%q) error = %v, wantErr %v", tt.in, err, tt.wantErr)
			}
			if err == nil && r.String() != tt.want {
				t.Errorf("Set(%q) then String() = %q, want %q", tt.in, r.String(), tt.want)
			}
		})
	}
}
```

`run` builds its own `http.Client`, which knows nothing about the in-memory network, so `startSite` calls `srv.Start()` to listen on a real loopback port instead. `run` takes its writers as parameters (since step 1), so the test captures stdout and stderr in buffers and checks the exit code without starting a process.

## Run it

Stop the test site first, to prove the suite does not need it:

```bash
go test -count=1 ./...
```

```text
ok  	example.com/linkcheck	1.037s
?   	example.com/linkcheck/cmd/testsite	[no test files]
ok  	example.com/linkcheck/internal/crawl	1.023s
```

`-count=1` bypasses the test cache, which otherwise prints `(cached)` for packages whose code and tests have not changed.

Coverage:

```bash
go test -cover ./...
```

```text
ok  	example.com/linkcheck	0.433s	coverage: 33.2% of statements
	example.com/linkcheck/cmd/testsite		coverage: 0.0% of statements
ok  	example.com/linkcheck/internal/crawl	1.004s	coverage: 88.2% of statements
```

The crawl package, where the logic lives, is well covered. `main` is a third covered because flag parsing and signal handling in `main()` are not called by the tests; the testsite has no tests at all. `go test -coverprofile=cover.out ./internal/crawl` followed by `go tool cover -html=cover.out` shows which lines are missed.

The race detector:

```bash
go test -count=1 -race ./...
```

```text
ok  	example.com/linkcheck	2.057s
?   	example.com/linkcheck/cmd/testsite	[no test files]
ok  	example.com/linkcheck/internal/crawl	2.095s
```

To see what it catches, change the counters in `crawler.go` from `atomic.Int64` to plain `int64` (`c.checked++`, `return c.checked, c.broken`) and run the progress test:

```bash
go test -race -run Progress ./internal/crawl
```

```text
==================
WARNING: DATA RACE
Read at 0x00c00021e068 by goroutine 14:
  example.com/linkcheck/internal/crawl.(*Crawler).Run.func1()
      C:/Users/Pratam/AppData/Local/Temp/race/internal/crawl/crawler.go:86 +0x204

Previous write at 0x00c00021e068 by goroutine 13:
  example.com/linkcheck/internal/crawl.(*Crawler).Run.func1()
      C:/Users/Pratam/AppData/Local/Temp/race/internal/crawl/crawler.go:86 +0x225
```

and, after more reports, the verdict:

```text
--- FAIL: TestCrawlerProgressWhileRunning (0.01s)
    testing.go:1865: race detected during execution of test
FAIL
FAIL	example.com/linkcheck/internal/crawl	1.741s
FAIL
```

Two workers incrementing the same counter is the first report; the test goroutine reading it through `Progress` is the next. Both pass tests without `-race`, which is why the race detector belongs in CI. Put the atomics back.

> [!NOTE]
> `-race` needs cgo and a C compiler on Windows and some other platforms. These runs used Go 1.27.1 on Windows with MinGW-w64 gcc on the `PATH`. On Linux and macOS it works with the default toolchain.

> [!WARNING]
> A test that sleeps for real time, such as `time.Sleep(2 * time.Second)` and then a check that the rate limiter let through about four requests, is slow and flaky: on a busy CI machine "about four" becomes three. Fake time with synctest makes the same test instant and exact. Keep real sleeps out of unit tests.

With the behaviour locked down, [[step-7-reporters]] can add output formats without fear of breaking the crawl.
