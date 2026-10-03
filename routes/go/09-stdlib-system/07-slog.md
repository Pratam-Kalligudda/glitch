---
title: Structured logging with slog
done_when: "Your program logs key-value records with levels as text or JSON, adds shared fields with With, and changes its log level without a rebuild."
---
A log line written for humans (`fetched https://go.dev in 120ms, status 200`) is hard for a program to search. A **structured** log record keeps the message and its data apart: a message, a level, a time and a list of key-value pairs called **attributes**. Tools can then filter `status=500` or sum `took` without parsing sentences. `log/slog` is the standard library's structured logger, with a front end (`*slog.Logger`) and a back end (a `slog.Handler`) that decides how records are written.

## Logging with text and JSON handlers

```go title="basic/main.go"
package main

import (
	"errors"
	"log/slog"
	"os"
	"time"
)

// dropTime removes the time attribute so the output is reproducible.
func dropTime(groups []string, a slog.Attr) slog.Attr {
	if a.Key == slog.TimeKey && len(groups) == 0 {
		return slog.Attr{}
	}
	return a
}

func main() {
	opts := &slog.HandlerOptions{Level: slog.LevelDebug, ReplaceAttr: dropTime}

	text := slog.New(slog.NewTextHandler(os.Stdout, opts))
	text.Debug("starting", "version", "1.0")
	text.Info("fetched", "url", "https://go.dev/doc", "status", 200, "took", 120*time.Millisecond)
	text.Warn("slow response", slog.Duration("took", 3*time.Second), slog.Bool("retry", true))
	text.Error("fetch failed", "err", errors.New("connection refused"), "attempt", 3)
	text.Info("odd args", "lonely")

	jl := slog.New(slog.NewJSONHandler(os.Stdout, opts))
	jl.Info("fetched", "url", "https://go.dev/doc", "status", 200, "took", 120*time.Millisecond)

	// With adds attributes to every later record; WithGroup nests them.
	reqLog := jl.With("request_id", "r-17").WithGroup("http")
	reqLog.Info("handled", "method", "GET", "status", 200)
	jl.Info("grouped", slog.Group("user", slog.String("name", "ada"), slog.Int("id", 7)))

	// A level threshold set at construction.
	quiet := slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelWarn, ReplaceAttr: dropTime}))
	quiet.Info("not shown")
	quiet.Warn("shown")
}
```

```bash
go run ./basic
```

```text
level=DEBUG msg=starting version=1.0
level=INFO msg=fetched url=https://go.dev/doc status=200 took=120ms
level=WARN msg="slow response" took=3s retry=true
level=ERROR msg="fetch failed" err="connection refused" attempt=3
level=INFO msg="odd args" !BADKEY=lonely
{"level":"INFO","msg":"fetched","url":"https://go.dev/doc","status":200,"took":120000000}
{"level":"INFO","msg":"handled","request_id":"r-17","http":{"method":"GET","status":200}}
{"level":"INFO","msg":"grouped","user":{"name":"ada","id":7}}
level=WARN msg=shown
```

Normally every record starts with a `time` attribute. The `ReplaceAttr` function above deletes it so that this output is the same on every run; a real run of `Info("hello", "n", 1)` through a text handler prints `time=2026-10-03T14:43:02.057+05:30 level=INFO msg=hello n=1` (your time and zone differ).

## How it works

**Four levels.** `Debug` (-4), `Info` (0), `Warn` (4), `Error` (8). A handler has a minimum level in `HandlerOptions.Level`; records below it are discarded before any formatting happens. The default minimum is `Info`, so the `Debug` call is silent unless you lower it.

**Message, then alternating key-value pairs.** `text.Info("fetched", "url", u, "status", 200)`. The message is constant text that says what happened; the variable data goes in attributes, so the same message always groups together in a log search. Do not format values into the message with `fmt.Sprintf`.

**Typed attributes.** The loose form `"status", 200` builds an `slog.Attr` for each pair at run time. `slog.String`, `slog.Int`, `slog.Bool`, `slog.Duration`, `slog.Any` and `slog.Group` build one directly, and `logger.LogAttrs(ctx, level, msg, attrs...)` takes only attributes, which skips the guessing and allocates less in hot code.

**Mistakes are visible, not fatal.** The `"odd args", "lonely"` call has a key with no value, and `slog` records it under the key `!BADKEY`. `go vet` finds this before it runs:

```text
basic\main.go:26:2: call to slog.Logger.Info missing a final value
```

**Text versus JSON.** `NewTextHandler` writes `key=value` lines, easy to read in a terminal. `NewJSONHandler` writes one JSON object per line, which log systems ingest. Note `"took":120000000`: JSON has no duration type, so it is the number of nanoseconds. Both write to any `io.Writer`; in a container, write to stdout or stderr and let the platform collect it.

**With and groups.** `logger.With("request_id", "r-17")` returns a new logger that attaches the attribute to every record, so a request handler makes one derived logger and passes it down. `WithGroup("http")` and `slog.Group` nest later attributes under a name: a JSON object, or `http.method=GET` in text.

## Beyond the basics

```go title="advanced/main.go"
package main

import (
	"bytes"
	"context"
	"fmt"
	"log"
	"log/slog"
	"os"
)

func dropTime(groups []string, a slog.Attr) slog.Attr {
	if a.Key == slog.TimeKey && len(groups) == 0 {
		return slog.Attr{}
	}
	return a
}

// secret hides its value from logs by implementing slog.LogValuer.
type secret string

func (secret) LogValue() slog.Value { return slog.StringValue("[redacted]") }

type ctxKey struct{}

// ctxHandler adds the request ID stored in the context to every record.
type ctxHandler struct{ slog.Handler }

func (h ctxHandler) Handle(ctx context.Context, r slog.Record) error {
	if id, ok := ctx.Value(ctxKey{}).(string); ok {
		r.AddAttrs(slog.String("request_id", id))
	}
	return h.Handler.Handle(ctx, r)
}

func main() {
	opts := &slog.HandlerOptions{ReplaceAttr: dropTime}

	// 1. A level you can change while the program runs.
	var level slog.LevelVar // starts at Info
	lv := slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: &level, ReplaceAttr: dropTime}))
	lv.Debug("hidden")
	level.Set(slog.LevelDebug)
	lv.Debug("visible now")

	// 2. LogValuer keeps secrets out.
	l := slog.New(slog.NewTextHandler(os.Stdout, opts))
	l.Info("login", "user", "ada", "password", secret("hunter2"))

	// 3. A handler that reads the context.
	cl := slog.New(ctxHandler{slog.NewTextHandler(os.Stdout, opts)})
	ctx := context.WithValue(context.Background(), ctxKey{}, "r-42")
	cl.InfoContext(ctx, "handling")
	cl.Info("no context value")

	// 4. Two destinations at once (Go 1.26).
	var file bytes.Buffer
	both := slog.New(slog.NewMultiHandler(
		slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelWarn, ReplaceAttr: dropTime}),
		slog.NewJSONHandler(&file, &slog.HandlerOptions{ReplaceAttr: dropTime}),
	))
	both.Info("only in the file")
	both.Warn("in both")
	fmt.Print("file got:\n", file.String())

	// 5. The default logger and the old log package.
	slog.SetDefault(l)
	slog.Info("via default")
	log.Print("via log package") // goes through the default slog handler at Info level
}
```

```bash
go run ./advanced
```

```text
level=DEBUG msg="visible now"
level=INFO msg=login user=ada password=[redacted]
level=INFO msg=handling request_id=r-42
level=INFO msg="no context value"
level=WARN msg="in both"
file got:
{"level":"INFO","msg":"only in the file"}
{"level":"WARN","msg":"in both"}
level=INFO msg="via default"
level=INFO msg="via log package"
```

1. **`slog.LevelVar`** is a level that can be changed safely at run time, from a flag, a signal or an admin endpoint, without rebuilding the handler. Pass its address as `Level`. A `*slog.LevelVar` also works as `Level` because it implements `slog.Leveler`.
2. **`slog.LogValuer`** lets a type control how it appears in logs: return a redacted string, or a group of just the safe fields. Types holding passwords, tokens or personal data should implement it so that logging one by mistake is harmless.
3. **A custom handler** implements `slog.Handler` (`Enabled`, `Handle`, `WithAttrs`, `WithGroup`). Embedding another handler and overriding one method, as `ctxHandler` does, is the usual way to add behaviour. The `...Context` methods (`InfoContext`) pass the context to `Handle`, which is how request-scoped data (a trace ID, [[context-values]]) reaches the log without being threaded through every call.
4. **`slog.NewMultiHandler`** (Go 1.26) sends each record to several handlers, each with its own level: here the terminal sees only warnings while the file receives everything. Its `Enabled` is true when any handler is enabled.
5. **The default logger.** `slog.Info(...)` uses the logger set by `slog.SetDefault`. `SetDefault` also redirects the old `log` package into it, so `log.Print` lines come out in the structured format at `Info` level, which helps when a dependency still uses `log`. Before any `SetDefault` the default handler writes the classic format, with no `key=value` quoting: `2026/10/03 14:42:09 INFO hello n=1`.

> [!WARNING]
> Formatting data into the message, and logging secrets or whole structs, are the two common mistakes. Symptom of the first: `logger.Info(fmt.Sprintf("user %s failed", name))` produces a different message for every user, so nothing groups and no filter on `user=` works. Symptom of the second: a password, token or full request body appears in your log files. Fix: constant message plus attributes (`"user", name`), and a `LogValuer` or an explicit short list of fields for sensitive types. Also avoid heavy work to build attributes for a call that will be filtered out: `Enabled` checks the level first, and `LogAttrs` or `logger.Enabled(ctx, slog.LevelDebug)` skip the expense.

> [!NOTE]
> Log to stderr, and keep stdout for the program's results, so a user can pipe the output of a command without the log lines in it ([[exit-codes]]). A server logs per request with a logger made by `With`; a CLI usually logs only with a `-v` flag, which is a boolean that moves a `LevelVar` to `Debug`.

linkcheck sends its diagnostics through `slog` to stderr and keeps stdout for results; its command-line flags are built in [[step-4-polite]].
