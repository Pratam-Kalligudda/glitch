---
title: "Step 1: check one page"
done_when: "With the testsite running, `go run . http://127.0.0.1:8080/` prints a status for each of the 10 links on the home page, ends with `10 links, 4 broken`, and exits with status 1."
---
linkcheck fetches one page, finds every link on it with `golang.org/x/net/html`, requests each link and prints its status, and a small embedded test site gives it something real to check.

Do this yourself first, then compare.

1. Create the module `example.com/linkcheck` with `go 1.27`, and run every command with Go 1.27.1 as in [[toolchain]] and [[modules]].
2. Put the reusable code in `internal/crawl`, so only this module can import it, as in [[packages]].
3. Add `golang.org/x/net/html` with `go get` and pin the version you get, as in [[dependencies]].
4. Write `cmd/testsite`: a server that embeds its pages with `//go:embed` ([[embed]]), serves them with `http.FileServerFS` and a few handlers that fail on purpose ([[http-server]]), and runs a second "external" site on another port.
5. Write `HTTPFetcher.Fetch`: build the request with a context, send it with an `http.Client`, close the body with `defer`, and read at most 5 MiB of HTML through `io.LimitReader` ([[http-client]], [[defer]], [[io-composition]]).
6. Write `Links`: parse the page with `html.Parse`, walk the tree with the `Descendants` iterator ([[range-func]]), resolve each `href` against the page URL and drop the fragment ([[url-parsing]]), and keep the first copy of each URL with a map ([[maps]]).
7. In `main`, read the URL from the arguments ([[flags-args]]), check each link, print one line per link, and exit with 0 (all good), 1 (something broken) or 2 (linkcheck could not run) as in [[exit-codes]].

## The code

The module has two programs: linkcheck itself at the root, and the test site under `cmd/testsite`.

```text
linkcheck/
  go.mod
  go.sum
  main.go
  internal/crawl/
    fetch.go
    links.go
  cmd/testsite/
    main.go
    site/
      index.html
      about.html
      about-print.html
      blog/
        index.html
        post-1.html
        post-2.html
```

Create the module and add the HTML parser:

```bash
mkdir linkcheck && cd linkcheck
go mod init example.com/linkcheck
go mod edit -go=1.27
go get golang.org/x/net/html@v0.59.0
```

```text title="go.mod"
module example.com/linkcheck

go 1.27

require golang.org/x/net v0.59.0
```

`go.sum` holds the checksums `go get` recorded; you never edit it by hand.

### linkcheck

```go title="main.go"
// Command linkcheck checks the links on a web page.
package main

import (
	"bytes"
	"context"
	"flag"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"

	"example.com/linkcheck/internal/crawl"
)

// Exit codes.
const (
	exitOK     = 0 // every link works
	exitBroken = 1 // at least one link is broken
	exitError  = 2 // linkcheck could not run
)

func main() {
	flag.Usage = func() {
		fmt.Fprintln(flag.CommandLine.Output(), "usage: linkcheck URL")
		flag.PrintDefaults()
	}
	flag.Parse()
	if flag.NArg() != 1 {
		flag.Usage()
		os.Exit(exitError)
	}
	os.Exit(run(context.Background(), flag.Arg(0), os.Stdout, os.Stderr))
}

func run(ctx context.Context, start string, stdout, stderr io.Writer) int {
	f := &crawl.HTTPFetcher{Client: &http.Client{}}

	page, err := f.Fetch(ctx, start)
	if err != nil {
		fmt.Fprintf(stderr, "linkcheck: %v\n", err)
		return exitError
	}
	if page.Status >= 400 || !page.HTML() {
		fmt.Fprintf(stderr, "linkcheck: %s: status %d, type %q\n", start, page.Status, page.ContentType)
		return exitError
	}
	base, err := url.Parse(page.URL)
	if err != nil {
		fmt.Fprintf(stderr, "linkcheck: %v\n", err)
		return exitError
	}
	links, err := crawl.Links(base, bytes.NewReader(page.Body))
	if err != nil {
		fmt.Fprintf(stderr, "linkcheck: %v\n", err)
		return exitError
	}

	broken := 0
	for _, link := range links {
		p, err := f.Fetch(ctx, link)
		switch {
		case err != nil:
			broken++
			fmt.Fprintf(stdout, "ERR  %s\n     %v\n", link, err)
		case p.Status >= 400:
			broken++
			fmt.Fprintf(stdout, "%d  %s\n", p.Status, link)
		default:
			fmt.Fprintf(stdout, "%d  %s\n", p.Status, link)
		}
	}
	fmt.Fprintf(stdout, "%d links, %d broken\n", len(links), broken)
	if broken > 0 {
		return exitBroken
	}
	return exitOK
}
```

`run` takes its context and both output streams as arguments instead of reaching for `os.Stdout` and `os.Exit` itself. `main` is the only function that touches the process; everything else can be called from a test, which [[step-6-tests]] relies on.

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
	Client *http.Client
}

// Fetch sends a GET request for rawURL. It returns an error only when no
// response arrives; an HTTP error status is reported in Page.Status.
func (f *HTTPFetcher) Fetch(ctx context.Context, rawURL string) (*Page, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return nil, err
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

`Fetch` separates two kinds of failure. When no response arrives (the server is down, DNS fails, the context is cancelled) it returns an error. When a response arrives with a 404 or a 500, that is a fact about the link, not a failure of `Fetch`, so it is returned in `Page.Status`. The client follows redirects by itself, so `resp.Request.URL` is the address that finally answered: relative links on a redirected page resolve against that one.

Non-HTML bodies are copied to `io.Discard` before the deferred `Close`. A body that is closed unread makes the transport throw away the connection; draining it lets the next request to the same host reuse it.

```go title="internal/crawl/links.go"
// Package crawl fetches HTML pages and finds the links in them.
package crawl

import (
	"io"
	"net/url"

	"golang.org/x/net/html"
)

// Links parses the HTML document in r and returns the absolute http and
// https URLs of its <a href> links. Relative links are resolved against
// base, fragments are dropped, and each URL appears once, in document order.
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
			u, err := base.Parse(attr.Val)
			if err != nil || (u.Scheme != "http" && u.Scheme != "https") {
				continue
			}
			u.Fragment = ""
			s := u.String()
			if !seen[s] {
				seen[s] = true
				links = append(links, s)
			}
		}
	}
	return links, nil
}
```

`base.Parse(attr.Val)` does what a browser does with an `href`: `about.html` on `http://127.0.0.1:8080/` becomes `http://127.0.0.1:8080/about.html`, `../about.html` climbs a directory, and an absolute URL stays as it is. `mailto:` links parse fine but are skipped by the scheme check, and `#top` resolves to the page itself once the fragment is cleared.

### The test site

The test site gives every run the same input: a few pages, a redirect, a 404, a 500, a slow page, a second "partner" site on port 8081, and a port where nothing listens. It never depends on someone else's server being up.

```go title="cmd/testsite/main.go"
// Command testsite serves a small website with some deliberately broken
// links, for trying out linkcheck without touching anyone else's server.
//
// It serves the pages in site/ on -addr, and a second, tiny "external"
// site on -other.
package main

import (
	"embed"
	"flag"
	"io/fs"
	"log"
	"net/http"
	"time"
)

//go:embed site
var siteFiles embed.FS

func main() {
	addr := flag.String("addr", "127.0.0.1:8080", "address of the main site")
	other := flag.String("other", "127.0.0.1:8081", "address of the external site")
	flag.Parse()

	site, err := fs.Sub(siteFiles, "site")
	if err != nil {
		log.Fatal(err)
	}

	mux := http.NewServeMux()
	mux.Handle("/", http.FileServerFS(site))
	mux.HandleFunc("/old-page", func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "/about.html", http.StatusMovedPermanently)
	})
	mux.HandleFunc("/error", func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "something went wrong", http.StatusInternalServerError)
	})
	mux.HandleFunc("/slow", func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-time.After(3 * time.Second):
			w.Write([]byte("finally\n"))
		case <-r.Context().Done():
		}
	})

	ext := http.NewServeMux()
	ext.HandleFunc("/ok.html", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Write([]byte("<!doctype html><title>External</title><p>Still here.</p>\n"))
	})

	go func() {
		log.Printf("external site on http://%s/", *other)
		log.Fatal(http.ListenAndServe(*other, ext))
	}()
	log.Printf("main site on http://%s/", *addr)
	log.Fatal(http.ListenAndServe(*addr, mux))
}
```

`//go:embed site` compiles the whole `site` directory into the binary; `fs.Sub` strips the `site/` prefix so `/about.html` maps to `site/about.html`. The `/slow` handler selects on the request's context, so it stops waiting as soon as the client gives up.

```html title="cmd/testsite/site/index.html"
<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Testsite</title></head>
<body>
<h1 id="top">Testsite</h1>
<ul>
  <li><a href="about.html">About us</a></li>
  <li><a href="/blog/">The blog</a></li>
  <li><a href="missing.html">A page that was never written</a></li>
  <li><a href="/old-page">An old address that redirects</a></li>
  <li><a href="/error">A page that fails on the server</a></li>
  <li><a href="/slow">A slow page</a></li>
  <li><a href="http://127.0.0.1:8081/ok.html">A partner site</a></li>
  <li><a href="http://127.0.0.1:8081/gone">A partner page that moved away</a></li>
  <li><a href="http://127.0.0.1:8099/">A server that is not running</a></li>
  <li><a href="mailto:team@example.com">Mail us</a></li>
  <li><a href="#top">Back to top</a></li>
</ul>
</body>
</html>
```

```html title="cmd/testsite/site/about.html"
<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>About</title></head>
<body>
<h1>About us</h1>
<p>We write about <a href="blog/">links</a>. Go <a href="./">home</a>.</p>
<p><a href="about-print.html">Printable version</a> · <a href="team.html#people">The team</a></p>
</body>
</html>
```

```html title="cmd/testsite/site/blog/index.html"
<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Blog</title></head>
<body>
<h1>Blog</h1>
<ul>
  <li><a href="post-1.html">First post</a></li>
  <li><a href="post-2.html">Second post</a></li>
</ul>
<p><a href="../about.html">About</a></p>
</body>
</html>
```

```html title="cmd/testsite/site/blog/post-1.html"
<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>First post</title></head>
<body>
<h1>First post</h1>
<p>Read the <a href="archive/2019.html">archive</a> or the <a href="post-2.html">next post</a>.</p>
</body>
</html>
```

```html title="cmd/testsite/site/blog/post-2.html"
<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Second post</title></head>
<body>
<h1>Second post</h1>
<p>Back to the <a href="HTTP://127.0.0.1:8080/blog/post-1.html">first post</a>, see the <a href="https://127.0.0.1:8081/ok.html">partner</a> (no TLS there), or <a href="/blog/drafts/">the drafts</a>.</p>
</body>
</html>
```

The printable page is a byte-for-byte copy of the about page. It is not a mistake: [[step-8-state]] detects exactly this kind of duplicate.

```bash
cp cmd/testsite/site/about.html cmd/testsite/site/about-print.html
```

## Run it

Start the test site in one terminal and leave it running for the rest of the capstone:

```bash
go run ./cmd/testsite
```

```text
2026/10/03 14:04:35 main site on http://127.0.0.1:8080/
2026/10/03 14:04:35 external site on http://127.0.0.1:8081/
```

In a second terminal, check the home page:

```bash
go run . http://127.0.0.1:8080/
```

```text
200  http://127.0.0.1:8080/about.html
200  http://127.0.0.1:8080/blog/
404  http://127.0.0.1:8080/missing.html
200  http://127.0.0.1:8080/old-page
500  http://127.0.0.1:8080/error
200  http://127.0.0.1:8080/slow
200  http://127.0.0.1:8081/ok.html
404  http://127.0.0.1:8081/gone
ERR  http://127.0.0.1:8099/
     Get "http://127.0.0.1:8099/": dial tcp 127.0.0.1:8099: connectex: No connection could be made because the target machine actively refused it.
200  http://127.0.0.1:8080/
10 links, 4 broken
exit status 1
```

The last line comes from `go run`, which reports the program's non-zero exit status. The connection error text comes from the operating system: this run is on Windows; on Linux and macOS it reads `connect: connection refused`.

Read the result against the page:

- `/old-page` shows 200 because the client followed the 301 to `/about.html`.
- `mailto:` is gone, and `#top` became `http://127.0.0.1:8080/`, the page itself.
- The run takes a little over three seconds, almost all of it spent waiting for `/slow`, because each link waits for the one before it. [[step-3-concurrent]] fixes that, and [[step-4-polite]] stops waiting for slow servers forever.

`go run` exits with 1 whenever the program fails, whatever code the program chose, so build a binary to see the real codes. `go build .` writes `linkcheck` (`linkcheck.exe` on Windows) in the current directory:

```bash
go build .
./linkcheck http://127.0.0.1:8080/ > /dev/null; echo $?
./linkcheck http://127.0.0.1:8099/; echo $?
./linkcheck; echo $?
```

```text
1
linkcheck: Get "http://127.0.0.1:8099/": dial tcp 127.0.0.1:8099: connectex: No connection could be made because the target machine actively refused it.
2
usage: linkcheck URL
2
```

Broken links give 1; a start page that cannot be fetched, or a missing argument, gives 2. A script or CI job can now tell "your site has broken links" from "linkcheck itself could not run".

Point it at another page to see a different set of links:

```bash
./linkcheck http://127.0.0.1:8080/about.html
```

```text
200  http://127.0.0.1:8080/blog/
200  http://127.0.0.1:8080/
200  http://127.0.0.1:8080/about-print.html
404  http://127.0.0.1:8080/team.html
4 links, 1 broken
```

The about page has a broken link of its own, and the blog has more, but linkcheck sees one page at a time. [[step-2-crawl]] follows the links.

> [!NOTE]
> Run `gofmt -l .` and `go vet ./...` after every step. Both print nothing when the code is clean, as in [[vet-fmt-fix]].
