---
title: The HTTP client
done_when: "You can make a request with a timeout, check its status, close its body, and explain why a 404 is not an error."
---
`net/http` has a client and a server in one package. The client is a `http.Client` that sends an `*http.Request` and returns an `*http.Response`. Its design has three consequences that catch most newcomers: a non-2xx status is not an error, the default client has no timeout, and you must close the response body.

Every example here talks to a local server made with `httptest.NewServer`, which listens on a random port of `127.0.0.1`. The port in your output will differ. [[httptest]] covers that package properly.

## A request, a status and a body

```go title="basic/main.go"
package main

import (
	"fmt"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
)

func main() {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/missing" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "text/plain")
		fmt.Fprintln(w, "hello from", r.URL.Path)
	}))
	defer srv.Close()

	for _, path := range []string{"/hello", "/missing"} {
		resp, err := http.Get(srv.URL + path)
		if err != nil {
			log.Fatal(err) // transport failure: no response at all
		}
		body, err := io.ReadAll(resp.Body)
		resp.Body.Close()
		if err != nil {
			log.Fatal(err)
		}
		fmt.Printf("%s -> %s, %s, %q\n", path, resp.Status, resp.Header.Get("Content-Type"), body)
	}

	// A closed port: the request fails before any response exists.
	srv.Close()
	_, err := http.Get(srv.URL)
	fmt.Println("after close:", err != nil)
}
```

```bash
go run ./basic
```

```text
/hello -> 200 OK, text/plain, "hello from /hello\n"
/missing -> 404 Not Found, text/plain; charset=utf-8, "404 page not found\n"
after close: true
```

## How it works

**`err` and the status are different questions.** `err` is non-nil when no response was obtained: the connection was refused, DNS failed, the deadline passed, the TLS handshake failed, the redirect limit was hit. When the server answered at all, `err` is nil, even for 404 or 500, because the HTTP exchange worked. You decide what a status means. For a link checker a 404 is the result, not a failure of the checker; for an API client it is usually an error you wrap:

```go
if resp.StatusCode < 200 || resp.StatusCode > 299 {
	return fmt.Errorf("GET %s: unexpected status %s", url, resp.Status)
}
```

**The body is a stream.** `resp.Body` is an `io.ReadCloser` ([[io-composition]]). The headers have arrived when `Do` returns; the body is read from the network as you read it. `io.ReadAll` buffers all of it in memory, which is fine for a small response and dangerous for an unknown one; wrap the body with `io.LimitReader(resp.Body, max)` when you cannot trust the size.

**`http.Get` is a shortcut.** It is `http.DefaultClient.Get`. `http.Head` and `http.Post` work the same way. For anything else (a method, headers, a context) build a request with `http.NewRequestWithContext` and call `client.Do(req)`.

## Timeouts: the default client has none

`http.DefaultClient` and `&http.Client{}` have a zero `Timeout`, which means "wait forever". A server that accepts the connection and never answers hangs your program for good. Always set a limit. There are two ways, and you can use both:

```go title="timeout/main.go"
package main

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"time"
)

func main() {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-time.After(2 * time.Second):
		case <-r.Context().Done():
		}
	}))
	defer srv.Close()

	// 1. A client-wide timeout covers connect, redirects and reading the body.
	client := &http.Client{Timeout: 200 * time.Millisecond}
	start := time.Now()
	_, err := client.Get(srv.URL)
	fmt.Println("client timeout:", err != nil, time.Since(start).Round(100*time.Millisecond))
	var te interface{ Timeout() bool }
	fmt.Println("is timeout:", errors.As(err, &te) && te.Timeout())
	fmt.Println(errors.Is(err, context.DeadlineExceeded))
	fmt.Fprintln(os.Stderr, err)

	// 2. A per-request context deadline, with no Client.Timeout.
	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, srv.URL, nil)
	_, err = http.DefaultClient.Do(req)
	fmt.Println("context deadline:", errors.Is(err, context.DeadlineExceeded))
	fmt.Fprintln(os.Stderr, err)
}
```

```bash
go run ./timeout
```

```text
client timeout: true 200ms
is timeout: true
true
Get "http://127.0.0.1:60997": context deadline exceeded (Client.Timeout exceeded while awaiting headers)
context deadline: true
Get "http://127.0.0.1:60997": context deadline exceeded
```

- **`Client.Timeout`** is one deadline for the whole exchange: connecting, sending, following redirects and reading the body. If the timer fires while you are still reading `resp.Body`, the read fails. It is the simplest safe default.
- **A request context** (`NewRequestWithContext`) carries a deadline or a cancellation for one request. Use it when different requests need different limits, or when the request must stop because something else was cancelled, such as the user pressing Ctrl-C ([[context]]). Cancelling the context aborts the request, including an unfinished body read.

Both errors satisfy `errors.Is(err, context.DeadlineExceeded)`, and the first one also satisfies the `Timeout() bool` interface, so retry logic can ask the question without parsing text ([[is-as]]). The error also names the URL, which is why wrapping it again with the same URL only adds noise.

> [!WARNING]
> `http.Get(url)` against a slow or hostile server never returns. Symptom: a program or a worker pool that stops making progress with every goroutine parked in `net/http` code; the process is alive and quiet. Fix: never use `http.DefaultClient` for real work. Create one `http.Client{Timeout: ...}` and reuse it, and pass a context on each request.

## Close the body, and read it

The `http.Transport` inside the client keeps a pool of idle connections so the next request to the same host skips the TCP and TLS setup. A connection returns to the pool only when the response body has been read to the end and closed. If you do not close the body, the connection and its goroutines stay allocated: a leak that grows with every request. If you close without reading, whether the connection is reused depends on how much data was left.

The next program measures reuse with `net/http/httptrace`, which calls your functions at each stage of a request. Its `GotConn` hook says whether the connection was taken from the pool. For each combination of body size and reading behaviour it makes a request, then a second one, and reports whether the second reused the first's connection:

```go title="reuse/main.go"
package main

import (
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/http/httptrace"
	"strconv"
	"strings"
)

// get makes one request and reports whether it reused a pooled connection.
func get(client *http.Client, url string, read bool) bool {
	reused := false
	trace := &httptrace.ClientTrace{
		GotConn: func(info httptrace.GotConnInfo) { reused = info.Reused },
	}
	req, _ := http.NewRequest(http.MethodGet, url, nil)
	req = req.WithContext(httptrace.WithClientTrace(req.Context(), trace))
	resp, err := client.Do(req)
	if err != nil {
		panic(err)
	}
	if read {
		io.Copy(io.Discard, resp.Body)
	}
	resp.Body.Close()
	return reused
}

func main() {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n, _ := strconv.Atoi(strings.TrimPrefix(r.URL.Path, "/"))
		w.Header().Set("Content-Length", strconv.Itoa(n))
		w.Write(make([]byte, n))
	}))
	defer srv.Close()

	for _, size := range []int{100, 1 << 20} {
		for _, read := range []bool{true, false} {
			// A fresh client (and so a fresh connection pool) per case.
			client := &http.Client{Transport: &http.Transport{}}
			get(client, srv.URL+"/"+strconv.Itoa(size), read)
			reused := get(client, srv.URL+"/"+strconv.Itoa(size), true)
			fmt.Printf("body %7d bytes, read to EOF before Close: %-5t -> next request reused connection: %t\n", size, read, reused)
		}
	}
}
```

```bash
go run ./reuse
```

```text
body     100 bytes, read to EOF before Close: true  -> next request reused connection: true
body     100 bytes, read to EOF before Close: false -> next request reused connection: true
body 1048576 bytes, read to EOF before Close: true  -> next request reused connection: true
body 1048576 bytes, read to EOF before Close: false -> next request reused connection: false
```

The second row is the Go 1.27 change. Go 1.27 release notes: HTTP/1 `Response.Body` "now automatically drains any unread content upon being closed, up to a conservative limit, to allow better connection reuse". Built with Go 1.25, the same program prints `false` for the second row: closing a body with unread bytes threw the connection away. The last row shows the limit: a megabyte is more than the transport will drain, so it closes the connection instead and the next request pays for a new one.

The rule that works on every version: when you will not use the rest of a body, but it may be small, drain it yourself before closing.

```go
io.Copy(io.Discard, io.LimitReader(resp.Body, 1<<16)) // discard up to 64 KiB
resp.Body.Close()
```

Draining is only worth it for bodies you expect to be small. For a large or unbounded body, close it and accept a new connection next time; reading it all just to save a handshake is slower. For a link checker, prefer a HEAD request, which has no body at all, and fall back to GET only when the server rejects HEAD.

> [!WARNING]
> The classic leak is returning early before `Close`: `if resp.StatusCode != 200 { return err }`. Symptom: memory and file descriptors grow, `too many open files` after thousands of requests, and `netstat` shows many open connections. Fix: put `defer resp.Body.Close()` immediately after the `err` check, before any other `return`. Close even when you ignore the body. Never `defer` it before checking `err`: on error `resp` is nil and `resp.Body` panics.

## Redirects, methods and headers

The client follows redirects by default (301, 302, 303, 307, 308), up to 10. `resp.Request` is the last request sent, so `resp.Request.URL` is the final URL. A `CheckRedirect` function on the client decides when to stop; returning `http.ErrUseLastResponse` hands you the redirect response itself, with its `Location` header, instead of following it. A link checker uses that to report redirects rather than hide them.

```go title="redirect/main.go"
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
	mux.HandleFunc("/old", func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "/new", http.StatusMovedPermanently)
	})
	mux.HandleFunc("/new", func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprintf(w, "%s %s, X-Token=%q\n", r.Method, r.URL.Path, r.Header.Get("X-Token"))
	})
	mux.HandleFunc("/loop", func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "/loop", http.StatusFound)
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	// 1. Redirects are followed; resp.Request is the last request made.
	resp, err := http.Get(srv.URL + "/old")
	if err != nil {
		panic(err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	fmt.Printf("followed: status %d, final path %s, body %q\n", resp.StatusCode, resp.Request.URL.Path, body)

	// 2. A client that reports the redirect instead of following it.
	noFollow := &http.Client{
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
	resp, err = noFollow.Get(srv.URL + "/old")
	if err != nil {
		panic(err)
	}
	resp.Body.Close()
	fmt.Printf("not followed: status %d, Location %s\n", resp.StatusCode, resp.Header.Get("Location"))

	// 3. A redirect loop stops after 10 redirects with an error.
	_, err = http.Get(srv.URL + "/loop")
	fmt.Println("loop:", err)

	// 4. A request with a method, body and header.
	req, _ := http.NewRequest(http.MethodPost, srv.URL+"/new", strings.NewReader(`{"a":1}`))
	req.Header.Set("X-Token", "abc")
	req.Header.Set("Content-Type", "application/json")
	resp, err = http.DefaultClient.Do(req)
	if err != nil {
		panic(err)
	}
	body, _ = io.ReadAll(resp.Body)
	resp.Body.Close()
	fmt.Printf("post: %s %q\n", resp.Status, body)

	// 5. HEAD returns headers only: cheap for a link checker.
	resp, err = http.Head(srv.URL + "/new")
	if err != nil {
		panic(err)
	}
	resp.Body.Close()
	fmt.Println("head:", resp.Status, "content-length", resp.ContentLength)
}
```

```bash
go run ./redirect
```

```text
followed: status 200, final path /new, body "GET /new, X-Token=\"\"\n"
not followed: status 301, Location /new
loop: Get "/loop": stopped after 10 redirects
post: 200 OK "POST /new, X-Token=\"abc\"\n"
head: 200 OK content-length 22
```

Headers go on the request with `req.Header.Set`; the client sends a default `User-Agent` of `Go-http-client/1.1` unless you set one, and many sites reject or throttle that, so a crawler should set its own. The request body is any `io.Reader`; `strings.NewReader` and `bytes.NewReader` also let the client set `Content-Length` and resend the body on a redirect.

## One client, shared

A `Client` is safe for use by many goroutines, and its `Transport` holds the connection pool. Create one client at start-up and share it. Making a new `http.Client{}` with its own `Transport` per request defeats pooling and leaks idle connections. A custom `Transport` is for tuning: `MaxIdleConnsPerHost` (default 2) limits how many idle connections each host keeps, which matters when many goroutines fetch from one host.

> [!NOTE]
> `Client.Timeout` includes reading the body. A download that legitimately takes minutes needs a request context instead, or a client with a long timeout. For finer control, `http.Transport` has `DialContext`, `TLSHandshakeTimeout` and `ResponseHeaderTimeout`.

linkcheck builds one shared client and sends every request with a context in [[step-1-single-page]], where it also closes every body, and sets its per-request timeout in [[step-4-polite]].
