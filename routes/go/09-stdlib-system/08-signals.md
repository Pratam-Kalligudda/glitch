---
title: Signals and graceful shutdown
done_when: "Pressing Ctrl-C makes your server stop accepting requests, finish the ones in flight, and exit with a message, and a second Ctrl-C ends it at once."
---
A **signal** is a message the operating system sends to a process: "the user pressed Ctrl-C", "please terminate", "your terminal closed". If the program does not handle it, the default action applies, and for most signals that is immediate termination. A program that stops mid-write loses data and leaves requests half-answered. A **graceful shutdown** catches the signal, stops taking new work, finishes what is running, releases resources and exits.

## The signals that matter

| Signal | Sent by | Default action |
|---|---|---|
| `SIGINT` (`os.Interrupt`) | Ctrl-C in a terminal | terminate |
| `SIGTERM` | `kill <pid>`, Docker stop, Kubernetes, systemd | terminate |
| `SIGKILL` | `kill -9`, the out-of-memory killer | terminate; **cannot be caught** |
| `SIGHUP` | terminal closed | terminate (daemons often reload config instead) |

`SIGKILL` and `SIGSTOP` cannot be caught or ignored; nothing can be done about them. Orchestrators send `SIGTERM` first, wait a grace period (Docker's default is 10 seconds), and only then `SIGKILL`, which is why your handler has a deadline.

> [!WARNING]
> Windows has no Unix signals. `os.Interrupt` works: Ctrl-C and Ctrl-Break in a console produce it. `syscall.SIGTERM` exists as a value and `signal.Notify` accepts it, but Go only delivers it when Windows sends a close, logoff or shutdown event to the process; `kill`-style termination from another program does not trigger it. You also cannot send `os.Interrupt` to another process with `Process.Signal` on Windows. Register `os.Interrupt` and `syscall.SIGTERM` together, as below: it is correct on every platform. The runs in this stop were made on Windows with Ctrl-Break sent by a small test program, which Go reports as the same `os.Interrupt`; on Linux or macOS you would use Ctrl-C or `kill -TERM <pid>`.

## Without a handler

A program that does not call `signal.Notify` is killed at once, and `defer` does not run:

```go title="plain/main.go"
package main

import (
	"fmt"
	"time"
)

func main() {
	defer fmt.Println("deferred cleanup ran")
	fmt.Println("ready")
	time.Sleep(10 * time.Second)
}
```

```text
ready
exit: exit status 0xc000013a
```

The deferred line never printed. The exit status is Windows' "terminated by Ctrl-C" code; on Linux a shell shows `130` (128 + signal 2) for Ctrl-C and `143` for `SIGTERM`. The process has no chance to flush a buffer, close a file or finish a response.

## Catching signals with Notify

`signal.Notify(c, sigs...)` asks the runtime to deliver the listed signals to the channel `c` instead of using the default action. Once a signal is registered, the program no longer dies on it; handling it is now your job.

```go title="notify/main.go"
package main

import (
	"fmt"
	"os"
	"os/signal"
	"syscall"
	"time"
)

func main() {
	// The channel must be buffered: signal never blocks to deliver.
	sigs := make(chan os.Signal, 1)
	signal.Notify(sigs, os.Interrupt, syscall.SIGTERM)
	fmt.Println("ready")

	sig := <-sigs
	fmt.Println("first signal:", sig, "- cleaning up (up to 3s)")

	select {
	case sig := <-sigs:
		fmt.Println("second signal:", sig, "- exiting now")
		os.Exit(130)
	case <-time.After(3 * time.Second):
		fmt.Println("cleanup finished")
	}
}
```

One Ctrl-C, then (in another run) two:

```text
ready
first signal: interrupt - cleaning up (up to 3s)
cleanup finished
```

```text
ready
first signal: interrupt - cleaning up (up to 3s)
second signal: interrupt - exiting now
```

The second run exits with status 130.

**Buffer the channel.** `signal` never blocks when delivering: if the channel is full, the signal is dropped. A signal that arrives while your goroutine is busy is lost on an unbuffered channel. A buffer of 1 per signal you must not miss is enough for this pattern.

**The first signal asks nicely, the second insists.** Users expect Ctrl-C twice to force-quit a program that is slow to stop. The program above gives cleanup three seconds, and a second signal ends it at once. `os.Exit` does not run deferred functions, and neither do the cleanup paths after it, so use it only as the last resort ([[exit-codes]]).

## NotifyContext: the signal as a cancellation

Most programs do not want a channel. They want a `context.Context` ([[context]]) that is cancelled when the signal arrives, because the code that must stop already takes a context. `signal.NotifyContext` does that:

```go title="app/main.go"
package main

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"
)

func main() {
	// ctx is cancelled on the first Ctrl-C (os.Interrupt) or SIGTERM.
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	mux := http.NewServeMux()
	mux.HandleFunc("GET /slow", func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(500 * time.Millisecond)
		fmt.Fprintln(w, "finished the slow request")
	})
	srv := &http.Server{Handler: mux, ReadHeaderTimeout: 5 * time.Second}

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		fmt.Println("listen:", err)
		os.Exit(1)
	}
	fmt.Println("listening on", ln.Addr())

	errc := make(chan error, 1)
	go func() { errc <- srv.Serve(ln) }()

	select {
	case err := <-errc:
		fmt.Println("server failed:", err)
		os.Exit(1)
	case <-ctx.Done():
		fmt.Println("signal received:", context.Cause(ctx))
	}

	stop() // restore default behaviour: a second Ctrl-C kills us immediately
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		fmt.Println("shutdown:", err)
		os.Exit(1)
	}
	if err := <-errc; !errors.Is(err, http.ErrServerClosed) {
		fmt.Println("serve:", err)
		os.Exit(1)
	}
	fmt.Println("shut down cleanly")
}
```

Run it, request `/slow` (for example with `curl`) and press Ctrl-C while the request is in flight. The test run sent the signal 150 ms into the request:

```text
listening on 127.0.0.1:64655
signal received: interrupt signal received
shut down cleanly
client saw: finished the slow request
exit: <nil>
```

The client got its answer even though the signal arrived mid-request, and the process exited with status 0. The last two lines belong to the test program that played the client.

## How it works

1. `NotifyContext` returns a child context and a `stop` function. It registers the signals; when one arrives the context is cancelled. Since Go 1.26 the context's **cause** says which signal: `context.Cause(ctx)` printed `interrupt signal received`, where `ctx.Err()` is just `context.Canceled`. Use the cause in a log line, and use `ctx.Err()` for the "was it cancelled" test.
2. The program waits in `select` for the server to fail or the context to be done. Without the `select`, a startup failure (the port is taken) would be noticed only after Ctrl-C.
3. `stop()` unregisters the handler. From then on a second Ctrl-C has the default action and kills the process. Without it, repeated signals would be swallowed while `Shutdown` waits, and an impatient user could not force an exit. `defer stop()` is also needed: it releases the registration on every path.
4. `srv.Shutdown` closes the listeners and waits for in-flight requests ([[http-server]]), bounded by a **new** context with a timeout. It must be new: `ctx` is already cancelled, and `Shutdown` with a cancelled context returns at once without waiting. Pick the timeout shorter than the orchestrator's grace period.
5. `Serve` returns `http.ErrServerClosed` immediately when `Shutdown` starts; that error means "stopped on purpose". The real result of the shutdown is what `Shutdown` returned, and the process should exit only after `Shutdown` completes, which is why `main` reads from `errc` afterwards.

The same context can be passed down to everything that should stop: a worker pool ([[worker-pools]]), HTTP requests made with `NewRequestWithContext` ([[http-client]]), a child process with `exec.CommandContext` ([[os-exec]]).

## os.Exit skips defers

`os.Exit(code)` ends the process immediately. Deferred functions do not run, buffered output is not flushed, and `Shutdown` is not called. Calling it inside a function that has deferred a `Close` or a `stop()` is a silent bug. The usual fix is to keep all work in a `run() error` function that returns, and call `os.Exit` only in `main`, after `run` has returned and its defers have run ([[exit-codes]]).

> [!WARNING]
> Three mistakes are common. (1) An unbuffered channel passed to `Notify`: symptom, Ctrl-C sometimes does nothing, because the signal arrived while the program was not receiving and was dropped. Fix: `make(chan os.Signal, 1)`. (2) Registering `SIGTERM` only: symptom, Ctrl-C kills the program on every platform. Fix: register `os.Interrupt` as well. (3) Using the cancelled signal context for the shutdown deadline, so `Shutdown` returns at once and in-flight requests are cut. Fix: `context.WithTimeout(context.Background(), ...)`.

> [!NOTE]
> A program that is a container's PID 1 must handle `SIGTERM` itself, because the default action for PID 1 is to ignore it; without a handler `docker stop` waits the full grace period and then sends `SIGKILL`. The program above handles it, so `docker stop` ends it in well under a second.

linkcheck uses `signal.NotifyContext` to cancel its crawl on Ctrl-C and still print a partial report in [[step-3-concurrent]], and shuts its report server down gracefully in [[step-7-reporters]].
