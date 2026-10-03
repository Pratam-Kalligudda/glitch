---
title: TCP with the net package
done_when: "You can run a TCP server that handles each connection in its own goroutine, dial it with a timeout, and tell a refused connection from a timeout."
---
Every HTTP request rides on a TCP connection, and the `net` package gives you that layer directly. TCP provides a **reliable, ordered stream of bytes** between two endpoints. It has no messages: if one side writes `"hello\n"` and then `"world\n"`, the other side may read them as one chunk, two, or half of one. Anything that needs message boundaries (a line, a length prefix) is up to your protocol.

You need this package for protocols that are not HTTP, for health checks, and for understanding what the HTTP client reports when something fails at the network level. The central types are:

- `net.Listener`: waits for incoming connections. `net.Listen("tcp", "127.0.0.1:0")` creates one; port `0` asks the OS for a free port.
- `net.Conn`: one connection. It is an `io.Reader`, an `io.Writer` and an `io.Closer` ([[io-composition]]), so `bufio`, `io.Copy` and `fmt.Fprintf` all work on it.
- `net.Dial`, `net.DialTimeout` and `net.Dialer`: open a connection to an address.

## A line-based echo server and its client

```go title="echo/main.go"
package main

import (
	"bufio"
	"errors"
	"fmt"
	"net"
	"strings"
	"sync"
	"time"
)

// serve accepts connections until the listener is closed.
func serve(ln net.Listener, wg *sync.WaitGroup) {
	for {
		conn, err := ln.Accept()
		if err != nil {
			if errors.Is(err, net.ErrClosed) {
				return
			}
			fmt.Println("accept:", err)
			return
		}
		wg.Add(1)
		go func() {
			defer wg.Done()
			handle(conn)
		}()
	}
}

// handle upper-cases each line it reads until the client closes.
func handle(conn net.Conn) {
	defer conn.Close()
	sc := bufio.NewScanner(conn)
	for sc.Scan() {
		fmt.Fprintf(conn, "%s\n", strings.ToUpper(sc.Text()))
	}
	fmt.Println("server: client", "gone, err =", sc.Err())
}

func main() {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		panic(err)
	}
	var wg sync.WaitGroup
	go serve(ln, &wg)

	conn, err := net.DialTimeout("tcp", ln.Addr().String(), time.Second)
	if err != nil {
		panic(err)
	}
	fmt.Println("local and remote addr are both 127.0.0.1:", strings.HasPrefix(conn.LocalAddr().String(), "127.0.0.1:"), strings.HasPrefix(conn.RemoteAddr().String(), "127.0.0.1:"))

	r := bufio.NewReader(conn)
	for _, msg := range []string{"hello", "tcp is a stream"} {
		fmt.Fprintf(conn, "%s\n", msg)
		line, err := r.ReadString('\n')
		fmt.Printf("sent %q, got %q, err %v\n", msg, line, err)
	}

	// Nobody replies to this: a read deadline turns a hang into an error.
	conn.SetReadDeadline(time.Now().Add(150 * time.Millisecond))
	_, err = r.ReadString('\n')
	var ne net.Error
	fmt.Println("read with deadline: timeout =", errors.As(err, &ne) && ne.Timeout())

	conn.Close()
	ln.Close()
	wg.Wait()
}
```

```bash
go run ./echo
```

```text
local and remote addr are both 127.0.0.1: true true
sent "hello", got "HELLO\n", err <nil>
sent "tcp is a stream", got "TCP IS A STREAM\n", err <nil>
read with deadline: timeout = true
server: client gone, err = <nil>
```

## How it works

**The accept loop.** `ln.Accept()` blocks until a client connects and returns a `net.Conn`. The loop hands each connection to a new goroutine and goes back to `Accept`, so one slow client does not block the others. This goroutine-per-connection design is the standard Go server shape and is cheap, because goroutines are ([[goroutines]]). The `http.Server` you met in [[http-server]] is this loop plus an HTTP parser.

**Stopping the loop.** Closing the listener makes a blocked `Accept` return an error that satisfies `errors.Is(err, net.ErrClosed)`; the loop treats it as the signal to stop. The `sync.WaitGroup` ([[waitgroup]]) lets `main` wait for the handlers. Any other `Accept` error (running out of file descriptors, for example) is a real problem and is reported.

**Framing with `bufio.Scanner`.** The handler reads lines, so the protocol's message boundary is `\n`. `Scanner` collects bytes until it sees one, however TCP chopped them up. The loop ends when the client closes its side (`Scan` returns false with `Err() == nil`) or on a network error. Without a protocol like this you would read from `conn` and get arbitrary pieces. `Scanner`'s default line limit is 64 KiB; a longer line ends the scan with `bufio.ErrTooLong`.

**Close what you open.** Each side calls `conn.Close()`. The handler uses `defer conn.Close()` so every path out of the function closes the connection.

**Deadlines turn waiting into errors.** A read on a connection blocks until data arrives or the connection closes, which may be never. `conn.SetReadDeadline(t)` sets an absolute time after which reads fail with an error whose `Timeout()` is true; `SetWriteDeadline` and `SetDeadline` (both) work the same. A deadline is a point in time, not a duration: you must set it again before each read, usually `time.Now().Add(d)`. A deadline already passed makes every later read fail immediately. A server without read deadlines can be held up by clients that connect and say nothing.

## Dialing: timeouts, DNS and what errors say

`net.Dial` blocks until the connection is made or fails. With no timeout it waits as long as the OS does (often over a minute), so use `net.DialTimeout` or a `net.Dialer`, which also supports a context:

```go title="errs/main.go"
package main

import (
	"context"
	"errors"
	"fmt"
	"net"
	"time"
)

func probe(addr string) error {
	d := net.Dialer{Timeout: 500 * time.Millisecond}
	conn, err := d.DialContext(context.Background(), "tcp", addr)
	if err != nil {
		return err
	}
	return conn.Close()
}

func main() {
	// Find a port nothing listens on: listen, note the address, close.
	ln, _ := net.Listen("tcp", "127.0.0.1:0")
	closedAddr := ln.Addr().String()
	ln.Close()

	err := probe(closedAddr)
	fmt.Println("dial:", err)
	var opErr *net.OpError
	if errors.As(err, &opErr) {
		fmt.Println("op:", opErr.Op, "net:", opErr.Net, "timeout:", opErr.Timeout())
	}

	_, err = net.LookupHost("no-such-host.invalid")
	var dnsErr *net.DNSError
	if errors.As(err, &dnsErr) {
		fmt.Println("dns: name", dnsErr.Name, "notfound", dnsErr.IsNotFound)
	}

	host, port, _ := net.SplitHostPort("[::1]:8080")
	fmt.Println(host, port, net.JoinHostPort("::1", "8080"))
	_, _, err = net.SplitHostPort("example.com")
	fmt.Println("split:", err)

	ip := net.ParseIP("192.168.1.10")
	fmt.Println(ip, ip.To4() != nil, ip.IsPrivate())
}
```

```bash
go run ./errs
```

```text
dial: dial tcp 127.0.0.1:57257: connectex: No connection could be made because the target machine actively refused it.
op: dial net: tcp timeout: false
dns: name no-such-host.invalid notfound true
::1 8080 [::1]:8080
split: address example.com: missing port in address
192.168.1.10 true true
```

The port in the first line varies. The wording of the refusal depends on the operating system: on Linux and macOS it ends in `connect: connection refused`. Do not match the text; use the structure. Network errors are `*net.OpError` values, which carry the operation (`dial`, `read`, `write`), the network and the address, and wrap the underlying cause. They satisfy `net.Error`, which adds `Timeout() bool`. That one method is what separates the two common failures:

| Situation | What you see | `Timeout()` |
|---|---|---|
| Nothing listens on the port (host is up) | refused, returned at once | false |
| Host drops packets, or a firewall silently ignores them | the dial waits until your timeout | true |
| Name does not exist | `*net.DNSError` with `IsNotFound` true | false |
| Name resolver unreachable or too slow | `*net.DNSError` with `IsTimeout` true | true |

A refusal is a fast, definite answer: the machine is reachable but no program listens. A timeout means silence. They call for different messages and different retry policies. Use `errors.As` ([[is-as]]) with `*net.OpError` or the `net.Error` interface; do not compare strings.

Addresses: always build and split `host:port` strings with `net.JoinHostPort` and `net.SplitHostPort`. An IPv6 address needs brackets (`[::1]:8080`), which string concatenation gets wrong. `net.ParseIP` returns `nil` for text that is not an IP.

## Where this meets HTTP

`http.Client` dials through `http.Transport`, whose `DialContext` field is a function with the signature of `(*net.Dialer).DialContext`. A `net.Dialer` with a short `Timeout` there limits how long connecting may take, separately from the whole-request timeout ([[http-client]]).

> [!WARNING]
> Treating the stream as messages is the classic TCP bug. A client writes two messages and the server reads `conn.Read(buf)` once, expecting two. Symptom: the program works on a laptop with tiny messages, then merges, splits or loses data in production. Fix: never assume one `Write` is one `Read`. Frame the stream (lines with `bufio.Scanner`/`ReadString`, a length prefix with `io.ReadFull` and [[binary]]) and always handle a short read. A second mistake is forgetting deadlines: a read from a silent peer blocks for ever, and so does the goroutine that made it ([[goroutine-leaks]]).

> [!NOTE]
> `net.Listen("tcp", ":8080")` listens on every interface; `127.0.0.1:8080` only on the local machine. For a development server or a test, bind the loopback address so nothing outside can reach it.

linkcheck's `--check-tcp` flag dials the host of each start URL, all at once, with the `--timeout` duration before crawling, and stops with exit code 2 if one fails, in [[step-4-polite]].
