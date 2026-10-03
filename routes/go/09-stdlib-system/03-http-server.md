---
title: The HTTP server
done_when: "You can register method and wildcard routes, read a path value, set the server timeouts, and shut a server down without cutting off a request in flight."
---
An HTTP server in Go is a value that implements one method. `http.Handler` is an interface with `ServeHTTP(w http.ResponseWriter, r *http.Request)`. The server accepts a connection, parses a request, calls your handler in a new goroutine, and sends what the handler wrote. A router is just a handler that picks another handler by looking at the request. The standard router is `http.ServeMux`.

## Routing with ServeMux

Since Go 1.22 a `ServeMux` pattern can name a method and contain wildcards, so most programs no longer need a router package.

```go title="mux/main.go"
package main

import (
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
)

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /{$}", func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprintln(w, "home")
	})
	mux.HandleFunc("GET /links/{code}", func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprintln(w, "show link", r.PathValue("code"))
	})
	mux.HandleFunc("DELETE /links/{code}", func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprintln(w, "delete link", r.PathValue("code"))
	})
	mux.HandleFunc("GET /links/new", func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprintln(w, "new link form")
	})
	mux.HandleFunc("GET /files/{path...}", func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprintln(w, "file", r.PathValue("path"))
	})
	mux.HandleFunc("GET /static/", func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprintln(w, "static subtree", r.URL.Path)
	})

	srv := httptest.NewServer(mux)
	defer srv.Close()
	client := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error {
		return http.ErrUseLastResponse
	}}

	for _, c := range []struct{ method, path string }{
		{"GET", "/"},
		{"GET", "/anything"},
		{"GET", "/links/abc"},
		{"GET", "/links/new"},
		{"DELETE", "/links/abc"},
		{"POST", "/links/abc"},
		{"GET", "/files/a/b/c.txt"},
		{"GET", "/static/css/site.css"},
		{"GET", "/static"},
		{"HEAD", "/links/abc"},
	} {
		req, _ := http.NewRequest(c.method, srv.URL+c.path, nil)
		resp, err := client.Do(req)
		if err != nil {
			panic(err)
		}
		body, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		extra := ""
		if a := resp.Header.Get("Allow"); a != "" {
			extra = " Allow: " + a
		}
		if l := resp.Header.Get("Location"); l != "" {
			extra += " Location: " + l
		}
		fmt.Printf("%-6s %-22s -> %d %s%s\n", c.method, c.path, resp.StatusCode, strings.TrimSpace(string(body)), extra)
	}
}
```

```bash
go run ./mux
```

```text
GET    /                      -> 200 home
GET    /anything              -> 404 404 page not found
GET    /links/abc             -> 200 show link abc
GET    /links/new             -> 200 new link form
DELETE /links/abc             -> 200 delete link abc
POST   /links/abc             -> 405 Method Not Allowed Allow: DELETE, GET, HEAD
GET    /files/a/b/c.txt       -> 200 file a/b/c.txt
GET    /static/css/site.css   -> 200 static subtree /static/css/site.css
GET    /static                -> 307 <a href="/static/">Temporary Redirect</a>. Location: /static/
HEAD   /links/abc             -> 200 
```

## The pattern rules

A pattern is `[METHOD ][HOST]/[PATH]`.

| Pattern | Matches |
|---|---|
| `/links/abc` | exactly that path, any method |
| `GET /links/abc` | `GET` and `HEAD` for that path |
| `/links/{code}` | one path segment, read with `r.PathValue("code")` |
| `/files/{path...}` | the rest of the path, including slashes, as one value |
| `/static/` | a trailing slash makes a subtree: `/static/` and everything under it |
| `/{$}` | exactly `/` and nothing else |
| `example.com/links/` | the host `example.com` only |

Behaviour worth knowing:

- **The most specific pattern wins**, not the first registered. `GET /links/new` beat `GET /links/{code}` for `/links/new` because a literal segment is more specific than a wildcard. The order of `HandleFunc` calls does not matter.
- **`/` matches everything**, because it is a subtree of the root. That is why the home page is `/{$}`: without `{$}` it would also answer every unknown path and the 404 above would never happen.
- **A `GET` pattern also matches `HEAD`**, if you did not register `HEAD` yourself. A pattern without a method matches all methods.
- **A wrong method is `405`, not `404`.** When a path matches but the method does not, the mux answers `405 Method Not Allowed` and fills the `Allow` header with the methods that would work (`DELETE, GET, HEAD` above).
- **A wildcard must be a whole segment.** `/links/{code}.html` is not a valid pattern; `{name}` fills a segment completely. Path values are already decoded: `%2F` arrives as `/` in the value.
- **Trailing slash redirect.** A request to `/static` for a registered `/static/` is redirected to `/static/`. As of Go 1.26 that redirect is `307 Temporary Redirect`; earlier versions sent `301 Moved Permanently`. A permanent redirect is cached by browsers for good, which made a mistake in a pattern hard to undo.

### Conflicting patterns panic at start-up

When two patterns match some of the same requests and neither is more specific, registration panics, so the mistake appears when the program starts and not in production:

```go title="conflict/main.go"
package main

import (
	"fmt"
	"net/http"
)

func main() {
	defer func() { fmt.Println("recovered:", recover()) }()
	mux := http.NewServeMux()
	h := func(w http.ResponseWriter, r *http.Request) {}
	mux.HandleFunc("GET /links/{code}", h)
	mux.HandleFunc("/links/{code}", h)   // more general: ok, the method pattern is more specific
	mux.HandleFunc("GET /{kind}/new", h) // overlaps with /links/{code} on /links/new
}
```

```text
recovered: pattern "GET /{kind}/new" (registered at .../conflict/main.go:14) conflicts with pattern "GET /links/{code}" (registered at .../conflict/main.go:12):
GET /{kind}/new and GET /links/{code} both match some paths, like "/links/new".
But neither is more specific than the other.
GET /{kind}/new matches "/kind/new", but GET /links/{code} doesn't.
GET /links/{code} matches "/links/code", but GET /{kind}/new doesn't.
```

The full file path in your output is shortened here. The fix is to make one pattern strictly narrower, for example by registering `GET /links/new` itself.

## Handlers, middleware and the response

A handler writes the response in a fixed order: **headers, then the status, then the body.** `w.Header().Set(...)` works only before the first write. `w.WriteHeader(code)` sends the status line and headers; a call to `w.Write` before it implies `200`. Calling `WriteHeader` twice, or setting a header after writing the body, has no effect on the response (the second status is logged as `superfluous response.WriteHeader call`). When a handler returns, the response ends.

**Middleware** is a function from handler to handler. It runs code before and after the wrapped handler, and it is how you add logging, authentication, panics recovery or timeouts to every route.

**Limit what you read.** A client chooses how much it sends. `http.MaxBytesReader(w, r.Body, n)` makes reads past `n` bytes fail with `*http.MaxBytesError`, and tells the server to close the connection.

## A server you can ship

```go title="prod/main.go"
package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"time"
)

type createReq struct {
	URL string `json:"url"`
}

type createResp struct {
	Code string `json:"code"`
	URL  string `json:"url"`
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

func createLink(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, 64) // refuse bodies over 64 bytes
	var req createReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		var tooBig *http.MaxBytesError
		if errors.As(err, &tooBig) {
			writeJSON(w, http.StatusRequestEntityTooLarge, map[string]string{"error": "body too large"})
			return
		}
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON"})
		return
	}
	writeJSON(w, http.StatusCreated, createResp{Code: "abc123", URL: req.URL})
}

// logging wraps a handler; every middleware has this shape.
func logging(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		next.ServeHTTP(w, r)
		fmt.Println("served", r.Method, r.URL.Path)
	})
}

func slow(w http.ResponseWriter, r *http.Request) {
	time.Sleep(300 * time.Millisecond)
	fmt.Fprintln(w, "slow done")
}

func post(url, body string) {
	resp, err := http.Post(url, "application/json", strings.NewReader(body))
	if err != nil {
		fmt.Println("post error:", err)
		return
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	fmt.Printf("%d %s", resp.StatusCode, b)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /links", createLink)
	mux.HandleFunc("GET /slow", slow)

	srv := &http.Server{
		Handler:           logging(mux),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       10 * time.Second,
		WriteTimeout:      10 * time.Second,
		IdleTimeout:       60 * time.Second,
	}

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		panic(err)
	}
	serveDone := make(chan error, 1)
	go func() { serveDone <- srv.Serve(ln) }()
	base := "http://" + ln.Addr().String()

	post(base+"/links", `{"url":"https://go.dev"}`)
	post(base+"/links", `{"url":`)
	post(base+"/links", `{"url":"https://example.com/`+strings.Repeat("x", 100)+`"}`)

	// Start a slow request, then shut down while it is in flight.
	slowDone := make(chan string)
	go func() {
		resp, err := http.Get(base + "/slow")
		if err != nil {
			slowDone <- "slow error: " + err.Error()
			return
		}
		defer resp.Body.Close()
		b, _ := io.ReadAll(resp.Body)
		slowDone <- strings.TrimSpace(string(b))
	}()
	time.Sleep(100 * time.Millisecond)

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	fmt.Println("shutdown:", srv.Shutdown(ctx))
	fmt.Println("in-flight request:", <-slowDone)
	fmt.Println("Serve returned:", <-serveDone)
	_, err = http.Get(base + "/slow")
	fmt.Println("after shutdown, request fails:", err != nil)
}
```

```bash
go run ./prod
```

```text
served POST /links
201 {"code":"abc123","url":"https://go.dev"}
served POST /links
400 {"error":"invalid JSON"}
served POST /links
413 {"error":"body too large"}
served GET /slow
shutdown: <nil>
in-flight request: slow done
Serve returned: http: Server closed
after shutdown, request fails: true
```

## How it works

**`http.Server` instead of `http.ListenAndServe`.** The package function builds a server with no timeouts. Create your own `http.Server` and set them:

| Field | Limits |
|---|---|
| `ReadHeaderTimeout` | time to read the request headers; the one to always set, it stops slow-header attacks |
| `ReadTimeout` | time to read the whole request, body included |
| `WriteTimeout` | time allowed to write the response; the timer restarts each time a new request's headers are read |
| `IdleTimeout` | how long a keep-alive connection may sit unused |

A server without them lets a client hold a connection and a goroutine open for as long as it likes.

**`Serve(ln)` blocks** until the server stops, and always returns a non-nil error. After `Shutdown` that error is `http.ErrServerClosed`, which means "stopped on purpose", so a `main` that treats every return as failure must exclude it with `errors.Is`. Making the listener yourself with `net.Listen` ([[net-tcp]]) lets you ask for port `0` (any free port) and read the real address, the same way `httptest` does. `ListenAndServe` is `net.Listen` plus `Serve` in one call.

**`Shutdown(ctx)` is graceful.** It closes the listeners, so no new connection is accepted, then waits for active requests to finish. In the run above the `/slow` request was in flight when `Shutdown` was called and still received `slow done`; a request made after the shutdown failed. If `ctx` expires first, `Shutdown` returns `ctx.Err()` and the remaining connections stay open; call `srv.Close()` to cut them. Wiring `Shutdown` to Ctrl-C is the subject of [[signals]].

**Each request runs in its own goroutine**, so handlers run concurrently. Any state they share (a map of links, a counter) needs a mutex ([[mutexes]]). A panic in a handler is recovered by the server, which logs it and closes that connection, but your middleware should recover too if it must send a response.

**`r.Context()`** is cancelled when the client goes away or the handler returns. Pass it to the database or HTTP call you make from the handler, so abandoned requests stop working ([[context]]).

> [!WARNING]
> `http.ListenAndServe(":8080", mux)` in production, with no timeouts, is the most common server mistake. Symptom: file descriptors and goroutines climb under a flood of half-open connections, or a few slow clients tie up memory, and the server stops answering. Fix: build an `http.Server` with at least `ReadHeaderTimeout` and `IdleTimeout`, and limit bodies with `http.MaxBytesReader`. A second mistake is returning after `WriteHeader(500)` but forgetting `return`, so the handler keeps writing a success body after the error: always `return` right after writing an error response.

> [!NOTE]
> `mux.Handle("/x", h)` takes an `http.Handler`; `mux.HandleFunc("/x", f)` takes a plain function. Use `http.ServeMux` to serve files with `http.FileServer(http.FS(fsys))` ([[filepath-fs]], [[embed]]); `http.StripPrefix` removes a prefix before the file server sees the path.

linkcheck serves its HTML report with exactly this kind of server and a graceful shutdown in [[step-7-reporters]].
