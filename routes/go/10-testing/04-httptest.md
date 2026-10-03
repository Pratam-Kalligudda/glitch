---
title: httptest
done_when: "Your HTTP fetcher is tested against a local server for 200, 404, a redirect and a timeout, and your handler is tested with a recorder, with no request leaving your machine."
---
Code that speaks HTTP has two sides, and the `net/http/httptest` package covers both:

- **A handler you wrote** (the server side) is tested by calling it directly with a fake request and a **recorder** that captures what it writes. No network, no port.
- **Code that calls a server** (the client side, such as linkcheck's fetcher) is tested against a real `http.Server` that `httptest` starts for the length of the test. The code under test makes an ordinary HTTP request and cannot tell the difference.

## Testing a handler with a recorder

`httptest.NewRequest(method, target, body)` builds an incoming `*http.Request` for a handler. `httptest.NewRecorder()` returns an `*httptest.ResponseRecorder`, an `http.ResponseWriter` that keeps what was written. You call `h.ServeHTTP(rec, req)` yourself and then inspect `rec`.

```text title="go.mod"
module example.com/httptest-demo

go 1.27
```

```go title="fetch.go"
// Package fetch checks URLs over HTTP and serves a small report.
package fetch

import (
	"context"
	"fmt"
	"net/http"
	"sort"
	"strings"
)

// HTTPFetcher reports the status of a URL. It tries HEAD first, which
// transfers no body, and falls back to GET for servers that refuse HEAD.
type HTTPFetcher struct {
	Client *http.Client // nil means http.DefaultClient
}

// Fetch returns the final status code, after redirects.
func (f *HTTPFetcher) Fetch(ctx context.Context, url string) (int, error) {
	client := f.Client
	if client == nil {
		client = http.DefaultClient
	}
	status, err := f.do(ctx, client, http.MethodHead, url)
	if err == nil && (status == http.StatusMethodNotAllowed || status == http.StatusNotImplemented) {
		status, err = f.do(ctx, client, http.MethodGet, url)
	}
	return status, err
}

func (f *HTTPFetcher) do(ctx context.Context, c *http.Client, method, url string) (int, error) {
	req, err := http.NewRequestWithContext(ctx, method, url, nil)
	if err != nil {
		return 0, err
	}
	resp, err := c.Do(req)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	return resp.StatusCode, nil
}

// ReportHandler serves GET /report as one "URL status" line per result and
// answers every other path with 404.
func ReportHandler(statuses map[string]int) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /report", func(w http.ResponseWriter, r *http.Request) {
		urls := make([]string, 0, len(statuses))
		for u := range statuses {
			urls = append(urls, u)
		}
		sort.Strings(urls)
		var b strings.Builder
		for _, u := range urls {
			fmt.Fprintf(&b, "%s %d\n", u, statuses[u])
		}
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		fmt.Fprint(w, b.String())
	})
	return mux
}
```

```go title="fetch_test.go"
package fetch

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestReportHandler(t *testing.T) {
	h := ReportHandler(map[string]int{"https://go.dev/": 200, "https://go.dev/x": 404})

	req := httptest.NewRequest(http.MethodGet, "/report", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if got, want := rec.Header().Get("Content-Type"), "text/plain; charset=utf-8"; got != want {
		t.Errorf("Content-Type = %q, want %q", got, want)
	}
	want := "https://go.dev/ 200\nhttps://go.dev/x 404\n"
	if got := rec.Body.String(); got != want {
		t.Errorf("body = %q, want %q", got, want)
	}
}

func TestReportHandlerOtherPath(t *testing.T) {
	h := ReportHandler(nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/nope", nil))
	if rec.Code != http.StatusNotFound {
		t.Errorf("status = %d, want 404", rec.Code)
	}
}

func TestFetchStatus(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/ok", func(w http.ResponseWriter, r *http.Request) {})
	mux.HandleFunc("/gone", func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "gone", http.StatusNotFound)
	})
	mux.HandleFunc("/old", func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "/ok", http.StatusMovedPermanently)
	})
	mux.HandleFunc("/no-head", func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodHead {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		io.WriteString(w, "body")
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	f := &HTTPFetcher{Client: srv.Client()}
	tests := []struct {
		name string
		path string
		want int
	}{
		{"ok", "/ok", 200},
		{"not found", "/gone", 404},
		{"redirect followed", "/old", 200},
		{"head refused", "/no-head", 200},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got, err := f.Fetch(t.Context(), srv.URL+tc.path)
			if err != nil {
				t.Fatalf("Fetch: %v", err)
			}
			if got != tc.want {
				t.Errorf("status = %d, want %d", got, tc.want)
			}
		})
	}
}

func TestFetchTimeout(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		<-r.Context().Done() // hang until the client gives up
	}))
	t.Cleanup(srv.Close)

	ctx, cancel := context.WithTimeout(t.Context(), 50*time.Millisecond)
	defer cancel()

	f := &HTTPFetcher{Client: srv.Client()}
	_, err := f.Fetch(ctx, srv.URL)
	if err == nil {
		t.Fatal("Fetch succeeded, want a deadline error")
	}
	t.Log("error:", err)
}
```

The handler tests are the first two functions (`TestReportHandler`, `TestReportHandlerOtherPath`); the rest of the file is the client side, below. Run all of it:

```bash
go vet . && go test -v .
```

```text
--- PASS: TestReportHandler (0.00s)
--- PASS: TestReportHandlerOtherPath (0.00s)
--- PASS: TestFetchStatus (0.00s)
    --- PASS: TestFetchStatus/ok (0.00s)
    --- PASS: TestFetchStatus/not_found (0.00s)
    --- PASS: TestFetchStatus/redirect_followed (0.00s)
    --- PASS: TestFetchStatus/head_refused (0.00s)
    fetch_test.go:97: error: Head "http://127.0.0.1:57262": context deadline exceeded
--- PASS: TestFetchTimeout (0.05s)
PASS
ok  	example.com/httptest-demo	0.377s
```

(`=== RUN` lines are left out. The port in the error changes every run.)

**What the recorder gives you.** `rec.Code` is the status (200 if the handler never called `WriteHeader`, as in Go's own server), `rec.Body` is a `*bytes.Buffer` with the body, and `rec.Header()` is the header map the handler built. `rec.Result()` returns a real `*http.Response` when you want to run the same checks you would on a client response. A recorder does no networking, so it cannot show connection behaviour, redirects followed by a client, or timeouts. Those need a server.

**Why `NewRequest` and not `http.NewRequest`.** `httptest.NewRequest` makes a *server-side* request: it fills in `RemoteAddr`, `RequestURI` and `Host` the way a received request has them, and it panics on a malformed target instead of returning an error, because a bad test fixture is a bug in the test. The `ServeMux` pattern `GET /report` matched here because the method and path are real; `/nope` fell through to 404.

## Testing a client against a server

`httptest.NewServer(handler)` starts an `http.Server` on a free loopback port and returns an `*httptest.Server`. Its `URL` is `http://127.0.0.1:<port>`, and `Close` stops it. Register `t.Cleanup(srv.Close)` right after creating it ([[test-helpers]]).

`TestFetchStatus` builds a small site out of a `ServeMux`: a page that is fine, one that is gone, a permanent redirect, and one that refuses `HEAD`. `HTTPFetcher` then runs against it exactly as it would against the Internet:

- **`ok`, `not found`:** the status comes back as the server sent it. A 404 is not a Go error: `Fetch` returns `404, nil`, and the caller decides that it is "broken" (see `Result.Broken` in [[test-doubles]]).
- **`redirect followed`:** `/old` answers 301 to `/ok`. The default client follows it, so the final status is 200. A test for how many redirects are followed needs a handler that counts.
- **`head refused`:** the fetcher sends `HEAD`, gets 405, and repeats the request as `GET`. This is the kind of behaviour a fake `Fetcher` cannot test, because it lives in the code *behind* the interface.

**`srv.Client()` returns an `*http.Client` already set up for the server.** Use it instead of `http.DefaultClient`. For a TLS server (`httptest.NewTLSServer`) it trusts the server's throw-away certificate, so you do not disable certificate checks anywhere. `HTTPFetcher` takes the client as a field for this reason; making the client injectable is what makes the real code testable.

**A timeout test hangs the handler on purpose.** `TestFetchTimeout`'s handler waits on `r.Context().Done()`, which the server cancels when the client goes away. The test gives the fetch a 50 ms deadline and the error is `context deadline exceeded`, wrapped by the HTTP client in `Head "http://127.0.0.1:57262"`. A handler that blocks on `r.Context()` rather than `time.Sleep` ends as soon as the client gives up, so the test does not wait for a sleep to finish before the server can close.

## The in-memory server (Go 1.27)

A loopback server uses a real TCP port. Thousands of tests, or tests in parallel, can run out of ports or hit a flaky local network. Go 1.27 adds `httptest.NewTestServer(t, handler)`, which serves over an **in-memory network** instead. It also takes the `*testing.T`, so it closes the server for you when the test ends; there is no `t.Cleanup(srv.Close)`.

```go title="inmem_test.go"
package fetch

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestFetchInMemory(t *testing.T) {
	srv := httptest.NewTestServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusTeapot)
	}))

	f := &HTTPFetcher{Client: srv.Client()}
	// The in-memory client sends every request to srv, whatever the host.
	got, err := f.Fetch(t.Context(), "http://example.invalid/anything")
	if err != nil {
		t.Fatalf("Fetch: %v", err)
	}
	if got != http.StatusTeapot {
		t.Errorf("status = %d, want 418", got)
	}
	t.Log("srv.URL:", srv.URL)
}
```

```bash
go test -v -run InMemory .
```

```text
=== RUN   TestFetchInMemory
    inmem_test.go:23: srv.URL: http://example.com
--- PASS: TestFetchInMemory (0.00s)
PASS
ok  	example.com/httptest-demo	0.377s
```

The test requested `http://example.invalid/anything`, a host that does not exist, and the handler still answered. The `srv.Client()` of an in-memory server sends every HTTP and HTTPS request to the test server, **whatever the host or port**; `srv.URL` is only a placeholder: it is `http://example.com`, and in Go 1.27.1 it stays an empty string until the server has handled its first request. Do not build URLs from it; write the URL the code under test would really use. So a test can fetch `https://go.dev/doc/` and get the handler's answer, which suits code that builds its own URLs from a crawled page.

Two consequences:

- Use `srv.Client()` for every request in the test. A request made with another client goes to the real network, because nothing about the URL says "test".
- The in-memory network is built to be used inside `testing/synctest` bubbles, where a test controls the clock; see [[synctest]]. Waiting on a real socket is not something the bubble can see as "blocked", so it cannot move fake time past it. Go's documentation recommends it for most tests, because it avoids port exhaustion and other transient network problems.

Use `NewServer` when you need a real socket: to test something that dials an address itself (such as a TCP preflight with `net.Dial`), or to run another program against the server's `URL`.

| Function | Does |
|---|---|
| `httptest.NewRecorder`, `NewRequest` | Test a handler directly, with no server |
| `httptest.NewServer(h)` | Real loopback HTTP server; you call `Close` |
| `httptest.NewTLSServer(h)` | The same with HTTPS and a test certificate; `Client()` trusts it |
| `httptest.NewTestServer(t, h)` (1.27) | In-memory server, closed by the test, synctest-compatible |
| `httptest.NewUnstartedServer(h)` | Create, adjust `Config` or `TLS`, then call `Start` |

## When Close hangs

`Server.Close` blocks until every outstanding request has finished. A handler that never returns therefore freezes the test at the cleanup:

```go title="hang/hang_test.go"
package hang

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestHang(t *testing.T) {
	entered := make(chan struct{})
	release := make(chan struct{}) // nobody ever closes this
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		close(entered)
		<-release
	}))
	t.Cleanup(srv.Close)

	go srv.Client().Get(srv.URL)
	<-entered
}
```

```bash
go test -timeout 2s ./hang
```

```text
panic: test timed out after 2s
	running tests:
		TestHang (2s)
...
goroutine 8 [sync.WaitGroup.Wait]:
sync.runtime_SemacquireWaitGroup(0x0?, 0x0?)
	.../sema.go:114 +0x2e
sync.(*WaitGroup).Wait(0x238a3ee4570)
	.../waitgroup.go:206 +0x85
net/http/httptest.(*Server).Close(0x238a3ee4500)
	.../httptest/server.go:524 +0x28f
testing.(*common).Cleanup.func1()
```

The trace says it: `httptest.(*Server).Close` waits in `sync.WaitGroup.Wait` for the request that `<-release` holds. Without `-timeout`, the default is ten minutes of nothing. Release the handler *before* the server closes. Cleanups run last in, first out, so register the release after `t.Cleanup(srv.Close)`:

```go
t.Cleanup(srv.Close)
t.Cleanup(func() { close(release) }) // runs first
```

With that line the test finishes in a few milliseconds.

> [!WARNING]
> Two mistakes recur with `httptest`. (1) **Using `http.DefaultClient`** with `srv.URL`: it works on a loopback server, then fails with a certificate error the day you switch to `NewTLSServer`, and silently hits the real network with the in-memory server. Always use `srv.Client()`. (2) **Forgetting `Close`**: the server and its goroutines outlive the test, and the next test sees a stray listener or a goroutine leak ([[goroutine-leaks]]). Use `t.Cleanup(srv.Close)`, or `NewTestServer`.

> [!NOTE]
> The recorder is not a perfect server. It does not enforce that a `Content-Length` matches the body, it ignores `Flush` timing, and it never closes a connection. Test those properties with a server.

linkcheck's own fetcher and its `run` function are tested with these tools in [[step-6-tests]]. The next stop, [[golden-files]], covers comparing a larger response body with a stored file.
