---
title: "Step 2: crawl one site"
done_when: "`go run . http://127.0.0.1:8080/` reports `17 links checked, 8 broken`, each broken link shows the page it is on, and `-depth 1` reports `10 links checked, 4 broken`."
---
linkcheck now follows the links it finds on the start host, up to a maximum depth, checks every distinct URL once, and reports each broken link with the page it was found on and a typed error explaining why.

Do this yourself first, then compare.

1. Write a generic `Set[T comparable]` backed by `map[T]struct{}`, whose zero value is ready to use, with pointer-receiver methods ([[type-parameters]], [[generic-types]], [[zero-values]], [[method-sets]]).
2. Write `Normalize` so two spellings of one address compare equal: lower-case host, no default port, `/` for an empty path, no fragment ([[url-parsing]], [[strings-pkg]]). Use it in `Links`.
3. Define `LinkError` with `Error` and `Unwrap`, and the sentinel `ErrBadStatus` it wraps for HTTP error statuses ([[sentinel-typed]], [[wrapping]], [[error-design]]).
4. Define `Outcome` with `iota` and give it a `String` method ([[constants-iota]], [[defined-types]], [[stringer-fmt]]).
5. Write the `Crawler`: a breadth-first loop over a queue of jobs, a visited set, and a depth limit. Remember what `queue = queue[1:]` does to the backing array ([[slices-internals]], [[append-aliasing]]).
6. Unwrap the client's `*url.Error` with `errors.AsType`, and in `main` tell bad statuses from network failures with `errors.Is` ([[is-as]], [[errors-as-values]]).
7. Add a `-depth` flag ([[flags-args]]) and print with `fmt` width verbs ([[fmt-verbs]]).

## The code

New files: `set.go`, `normalize.go`, `errors.go`, `result.go`, `crawler.go` in `internal/crawl`. Changed: `main.go`, `internal/crawl/links.go`. Unchanged: `go.mod`, `go.sum`, `internal/crawl/fetch.go`, everything under `cmd/testsite`.

```go title="internal/crawl/set.go"
package crawl

// Set is a set of comparable values. The zero value is an empty set ready
// to use.
type Set[T comparable] struct {
	m map[T]struct{}
}

// Add adds v to the set. It reports whether v was new.
func (s *Set[T]) Add(v T) bool {
	if _, ok := s.m[v]; ok {
		return false
	}
	if s.m == nil {
		s.m = make(map[T]struct{})
	}
	s.m[v] = struct{}{}
	return true
}

// Has reports whether v is in the set.
func (s *Set[T]) Has(v T) bool {
	_, ok := s.m[v]
	return ok
}

// Len returns the number of values in the set.
func (s *Set[T]) Len() int {
	return len(s.m)
}
```

The value type `struct{}` takes no memory, so the map stores keys only. `Add` returns whether the value was new, so "check, then insert" is one call and one map lookup in the common case. The methods have pointer receivers because `Add` may create the map: on a value receiver it would create a map in a copy and lose it.

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

// Normalize resolves ref against base and returns it in a canonical form,
// so that two spellings of the same address compare equal: the host is
// lower case, a default port is removed, an empty path becomes "/", and
// the fragment is dropped.
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
	u.Host = host
	if u.Path == "" {
		u.Path = "/"
	}
	u.Fragment = ""
	u.RawFragment = ""
	return u.String(), nil
}
```

Without normalizing, `http://127.0.0.1:8080/blog/post-1.html#top`, `HTTP://127.0.0.1:8080/blog/post-1.html` and `http://127.0.0.1:8080/blog/post-1.html` are three keys in the visited set and three requests. `url.Parse` already lowercases the scheme; `Normalize` does the rest. It is a pure function of its inputs, which makes it the target of a fuzz test in [[step-6-tests]].

```go title="internal/crawl/links.go"
// Package crawl fetches HTML pages and finds the links in them.
package crawl

import (
	"io"
	"net/url"

	"golang.org/x/net/html"
)

// Links parses the HTML document in r and returns the http and https URLs
// of its <a href> links, resolved against base and normalized with
// Normalize. Each URL appears once, in document order.
func Links(base *url.URL, r io.Reader) ([]string, error) {
	doc, err := html.Parse(r)
	if err != nil {
		return nil, err
	}
	var links []string
	seen := make(map[string]bool)
	for n := range doc.Descendants() {
		if n.Type != html.ElementNode || n.Data != "a" {
			continue
		}
		for _, attr := range n.Attr {
			if attr.Key != "href" {
				continue
			}
			s, err := Normalize(base, attr.Val)
			if err != nil {
				continue
			}
			if !seen[s] {
				seen[s] = true
				links = append(links, s)
			}
		}
	}
	return links, nil
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

`LinkError` carries what a caller needs to act on: which URL, which status, and the cause. `Unwrap` makes the cause visible to `errors.Is` and `errors.As`, so a caller can ask "was this a bad status?" with `errors.Is(err, crawl.ErrBadStatus)` without parsing the message.

```go title="internal/crawl/result.go"
package crawl

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
}

// Outcome reports whether the link works.
func (r Result) Outcome() Outcome {
	if r.Err != nil {
		return Broken
	}
	return OK
}
```

```go title="internal/crawl/crawler.go"
package crawl

import (
	"bytes"
	"context"
	"errors"
	"net/url"
)

// Crawler checks every link on a site, following links on the start URL's
// host up to MaxDepth clicks away. Links to other hosts are checked but
// not followed.
type Crawler struct {
	Fetcher  *HTTPFetcher
	MaxDepth int
}

type job struct {
	url    string
	parent string
	depth  int
}

// Run crawls from start and returns one Result per distinct URL, in the
// order the URLs were checked.
func (c *Crawler) Run(ctx context.Context, start string) ([]Result, error) {
	startURL, err := url.Parse(start)
	if err != nil {
		return nil, err
	}
	first, err := Normalize(startURL, "")
	if err != nil {
		return nil, err
	}

	var visited Set[string]
	visited.Add(first)
	queue := []job{{url: first}}
	var results []Result

	for len(queue) > 0 {
		j := queue[0]
		queue = queue[1:]

		res, links := c.visit(ctx, j, startURL.Host)
		results = append(results, res)
		for _, link := range links {
			if visited.Add(link) {
				queue = append(queue, job{url: link, parent: j.url, depth: j.depth + 1})
			}
		}
	}
	return results, nil
}

// visit checks one URL. If the URL is an HTML page on the start host and
// is not too deep, it also returns the links on the page.
func (c *Crawler) visit(ctx context.Context, j job, host string) (Result, []string) {
	res := Result{URL: j.url, Parent: j.parent, Depth: j.depth}
	page, err := c.Fetcher.Fetch(ctx, j.url)
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

How the crawl works:

1. The start URL is normalized and marked visited before anything is fetched, so a page linking back to the home page does not queue it again.
2. Each job is fetched. A network error or a status of 400 or more becomes a `*LinkError` in the result, and the crawl goes on: one broken link is data, not a reason to stop.
3. A page is parsed for links only if it is HTML, on the start host (after redirects, so a redirect to another site is not crawled) and shallower than `MaxDepth`. Links to other hosts are still checked, because they come back from `visit` on the same page that found them.
4. `visited.Add` returns true only the first time, so each URL is queued once, with the parent and depth of its first sighting.

`queue = queue[1:]` moves the start of the slice forward without copying, and `append` reuses the spare capacity at the end. The backing array only grows; for a crawl of a few thousand pages that is fine, and the queue disappears when `Run` returns.

```go title="main.go"
// Command linkcheck crawls a website and reports broken links.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"

	"example.com/linkcheck/internal/crawl"
)

// Exit codes.
const (
	exitOK     = 0 // every link works
	exitBroken = 1 // at least one link is broken
	exitError  = 2 // linkcheck could not run
)

// config holds the settings from the command line.
type config struct {
	depth int
}

func main() {
	var cfg config
	flag.IntVar(&cfg.depth, "depth", 3, "follow links up to `n` clicks from the start page")
	flag.Usage = func() {
		fmt.Fprintln(flag.CommandLine.Output(), "usage: linkcheck [flags] URL")
		flag.PrintDefaults()
	}
	flag.Parse()
	if flag.NArg() != 1 {
		flag.Usage()
		os.Exit(exitError)
	}
	os.Exit(run(context.Background(), cfg, flag.Arg(0), os.Stdout, os.Stderr))
}

func run(ctx context.Context, cfg config, start string, stdout, stderr io.Writer) int {
	c := &crawl.Crawler{
		Fetcher:  &crawl.HTTPFetcher{Client: &http.Client{}},
		MaxDepth: cfg.depth,
	}
	results, err := c.Run(ctx, start)
	if err != nil {
		fmt.Fprintf(stderr, "linkcheck: %v\n", err)
		return exitError
	}
	if results[0].Err != nil {
		fmt.Fprintf(stderr, "linkcheck: start page: %v\n", results[0].Err)
		return exitError
	}

	broken := 0
	for _, r := range results {
		if r.Outcome() == crawl.OK {
			continue
		}
		broken++
		printBroken(stdout, r)
	}
	fmt.Fprintf(stdout, "%d links checked, %d broken\n", len(results), broken)
	if broken > 0 {
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

The crawler records a failed start page like any other result. `run` checks `results[0]` and treats it as "could not run" (exit 2), because a crawl that never got past its first page has nothing to report.

## Run it

With the testsite running (`go run ./cmd/testsite`):

```bash
go run . http://127.0.0.1:8080/
```

```text
404  http://127.0.0.1:8080/missing.html
     on http://127.0.0.1:8080/
500  http://127.0.0.1:8080/error
     on http://127.0.0.1:8080/
404  http://127.0.0.1:8081/gone
     on http://127.0.0.1:8080/
ERR  http://127.0.0.1:8099/
     on http://127.0.0.1:8080/
     dial tcp 127.0.0.1:8099: connectex: No connection could be made because the target machine actively refused it.
404  http://127.0.0.1:8080/team.html
     on http://127.0.0.1:8080/about.html
404  http://127.0.0.1:8080/blog/archive/2019.html
     on http://127.0.0.1:8080/blog/post-1.html
ERR  https://127.0.0.1:8081/ok.html
     on http://127.0.0.1:8080/blog/post-2.html
     http: server gave HTTP response to HTTPS client
404  http://127.0.0.1:8080/blog/drafts/
     on http://127.0.0.1:8080/blog/post-2.html
17 links checked, 8 broken
exit status 1
```

Four broken links were invisible from the home page alone. `post-2.html` links to `HTTP://127.0.0.1:8080/blog/post-1.html`; that is not in the list of 17 twice, because `Normalize` made it equal to the link the blog index already queued.

Limit the depth to the home page's own links:

```bash
go run . -depth 1 http://127.0.0.1:8080/
```

The last line is the same count as step 1:

```text
10 links checked, 4 broken
```

A start page that fails is an error, not a report:

```bash
go build .
./linkcheck http://127.0.0.1:8080/nothing; echo $?
```

```text
linkcheck: start page: http://127.0.0.1:8080/nothing: 404 Not Found
2
```

The whole crawl still runs one request at a time and takes about five seconds, three of them waiting on `/slow`. [[step-3-concurrent]] runs the checks in parallel.
