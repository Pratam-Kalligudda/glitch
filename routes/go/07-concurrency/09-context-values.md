---
title: Context values
---
A context can also carry values: data that belongs to one request or one run and has to
reach code several calls deep, such as a request ID, a trace ID or the authenticated user.
`context.WithValue(parent, key, val)` returns a child context that carries `val` under
`key`, and `ctx.Value(key)` looks it up. The point is to pass request-scoped data through
APIs that should not know about it, such as an HTTP client or a database driver, without
adding a parameter to every function in between.

The package documentation draws the line: use context values "only for request-scoped
data that transits processes and APIs, not for passing optional parameters to
functions."

## The idiom: an unexported key type and typed accessors

A package that stores a value owns its key, and exposes two functions instead of the key:

```text title="go.mod"
module example.com/linkcheck

go 1.27
```

```go title="runid/runid.go"
// Package runid attaches a crawl's run ID to a context.
package runid

import "context"

// key is unexported, so no other package can create a key equal to it.
type key struct{}

// With returns a copy of ctx that carries id.
func With(ctx context.Context, id string) context.Context {
	return context.WithValue(ctx, key{}, id)
}

// From returns the run ID in ctx, and whether there was one.
func From(ctx context.Context) (string, bool) {
	id, ok := ctx.Value(key{}).(string)
	return id, ok
}
```

```go title="cmd/demo/main.go"
package main

import (
	"context"
	"fmt"
	"time"

	"example.com/linkcheck/runid"
)

func check(ctx context.Context, url string) {
	id, ok := runid.From(ctx)
	if !ok {
		id = "none"
	}
	fmt.Printf("[run %s] checking %s\n", id, url)
}

func main() {
	ctx := runid.With(context.Background(), "7f3a")
	ctx, cancel := context.WithTimeout(ctx, time.Second) // values survive derivation
	defer cancel()

	check(ctx, "https://go.dev/")
	check(context.Background(), "https://example.com/")
}
```

```bash
go run ./cmd/demo
```

```text
[run 7f3a] checking https://go.dev/
[run none] checking https://example.com/
```

## How it works

`WithValue` does not modify anything. It wraps the parent in a new node that holds one
key and one value. `ctx.Value(k)` compares `k` with the node's key; if they differ, it
asks the parent, and so on up to the root, which returns `nil`. So:

- **Lookup is a linear walk** up the chain. That is fine for the handful of values a
  request carries, and a reason not to use a context as a general map.
- **Values flow down, never up.** A function that adds a value creates a new context;
  its caller still holds the old one and cannot see the value. To return data, return it.
- **Derived contexts keep values.** `WithTimeout`, `WithCancel` and `WithoutCancel` all
  wrap the parent, so the run ID above survived `WithTimeout`.
- **Keys are compared with `==`, type included.** Two keys are equal only if they have the
  same dynamic type and value. `WithValue` panics with `key is not comparable` for a
  slice or map key, and with `nil key` for `nil`.

The key type `struct{}` is unexported, so no other package can write `key{}`; the only
way to set or read the value is through `With` and `From`. An empty struct also takes no
memory, and converting it to `any` does not allocate. `From` uses the two-value type
assertion ([[assertions-switches]]) so a missing value gives `ok == false` instead of a
panic.

## Why the key must not be a string

```go title="collide/main.go"
package main

import (
	"context"
	"fmt"
)

// Two packages that both chose the string "id" as a key.
func authMiddleware(ctx context.Context) context.Context {
	return context.WithValue(ctx, "id", "user-42")
}

func tracing(ctx context.Context) context.Context {
	return context.WithValue(ctx, "id", "trace-9b1c")
}

// Typed keys: same underlying value, different types, so different keys.
type userKey string
type traceKey string

func main() {
	ctx := tracing(authMiddleware(context.Background()))
	fmt.Println("user id:", ctx.Value("id")) // the auth value is shadowed

	ctx = context.WithValue(context.Background(), userKey("id"), "user-42")
	ctx = context.WithValue(ctx, traceKey("id"), "trace-9b1c")
	fmt.Println("user id:", ctx.Value(userKey("id")))
	fmt.Println("trace id:", ctx.Value(traceKey("id")))
}
```

```text
user id: trace-9b1c
user id: user-42
trace id: trace-9b1c
```

Two unrelated packages used `"id"`, and the lookup found the nearest one: the trace ID
came back as the user ID. Nothing failed at compile time and nothing panicked. With
defined key types ([[defined-types]]) the two keys differ even though both hold `"id"`.
The `context` docs say keys should not be `string` or any other built-in type for this
reason.

## What belongs in a context

| Put in a context | Pass as a parameter instead |
|---|---|
| Request or run ID, trace and span IDs | Configuration: timeouts, limits, flags |
| The authenticated principal for this request | Database handles, HTTP clients, loggers you construct |
| Data a middleware adds for code it cannot change | Anything a function needs to do its job |

A useful test: if the function would be wrong without the value, it is a parameter. A
request ID is not needed to check a link; it only labels the log lines. A max depth is
needed, so it is a parameter or a field.

> [!WARNING]
> Using context values as hidden parameters. Symptom: a function's signature says
> `(ctx, url)` but it silently fails, or uses a default, when called from a test or a new
> caller that did not put the right value in the context; nothing in the type system says
> the value is required. Fix: make required inputs explicit parameters or struct fields,
> and keep context values for optional, cross-cutting data that has a sensible behaviour
> when missing, as `runid.From` does with its `ok` result.

> [!NOTE]
> `log/slog` has context-aware methods such as `InfoContext(ctx, ...)` that pass the
> context to the handler, so a handler can read a request ID from it and add it to every
> line. [[slog]] shows the pattern.

The run ID linkcheck gives each crawl in [[step-8-state]] is exactly the kind of value
that belongs in a context: it labels the work without changing what the work does.
