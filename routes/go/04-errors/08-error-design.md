---
title: Designing a package's errors
done_when: "Your package exports only the sentinels and error types callers must branch on, documents which functions return them, wraps dependency errors only on purpose, and handles each error exactly once."
---
The earlier stops gave you the mechanics: wrapping, `errors.Is`, `errors.AsType`,
sentinels, types, joins. Designing a package's errors means choosing among them so that
callers can act on failures without depending on your implementation. Every exported
error, and every error you wrap with `%w`, becomes part of the package's API, as binding as
a function signature. The questions to answer for each failure are:

1. **Does any caller need to react to this failure differently from others?** If not,
   return a plain error with a good message and export nothing.
2. **If yes, does the caller need data about it?** No: a sentinel. Yes: an error type.
3. **Does the cause come from a dependency?** Wrap it with `%w` only if you promise to
   keep returning it; otherwise keep its text with `%v`, or translate it to your own error.
4. **Where is it handled?** Exactly once: either returned with context, or logged (or
   shown, or turned into an exit code). Not both.

Here is a small package that checks one link, designed with those questions, and a `main`
that uses it.

```text title="go.mod"
module example.com/errdesign

go 1.27
```

```go title="check/check.go"
// Package check checks one link and reports why it is broken.
package check

import (
	"errors"
	"fmt"
	"net/url"
)

// Errors callers can test for with errors.Is. Each is part of the API.
var (
	// ErrInvalidURL means the link could not be parsed as an absolute http(s) URL.
	ErrInvalidURL = errors.New("invalid URL")
	// ErrBroken means the server answered with a 4xx or 5xx status.
	ErrBroken = errors.New("broken link")
)

// LinkError describes a failed link. Link returns it for every failure;
// use errors.AsType[*check.LinkError] to read the fields.
type LinkError struct {
	URL    string // the link as written on the page
	From   string // the page the link was found on
	Status int    // HTTP status, or 0 if no response was received
	Err    error  // the cause; matches ErrInvalidURL, ErrBroken, or a network error
}

func (e *LinkError) Error() string {
	if e.Status != 0 {
		return fmt.Sprintf("check %s (from %s): status %d: %v", e.URL, e.From, e.Status, e.Err)
	}
	return fmt.Sprintf("check %s (from %s): %v", e.URL, e.From, e.Err)
}

func (e *LinkError) Unwrap() error { return e.Err }

// Getter fetches a URL and returns its HTTP status.
type Getter interface {
	Get(url string) (status int, err error)
}

// Link checks the link rawURL found on page from.
// It returns nil if the link answers with a status below 400.
// Every other result is a *LinkError whose cause is ErrInvalidURL, ErrBroken,
// or the error returned by g, wrapped unchanged.
func Link(g Getter, from, rawURL string) error {
	u, err := url.Parse(rawURL)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		// The url package's error is an implementation detail: keep its text, not its type.
		cause := ErrInvalidURL
		if err != nil {
			cause = fmt.Errorf("%w: %v", ErrInvalidURL, err)
		}
		return &LinkError{URL: rawURL, From: from, Err: cause}
	}
	status, err := g.Get(u.String())
	if err != nil {
		// Network errors are wrapped: callers may want to retry timeouts.
		return &LinkError{URL: rawURL, From: from, Err: err}
	}
	if status >= 400 {
		return &LinkError{URL: rawURL, From: from, Status: status, Err: ErrBroken}
	}
	return nil
}
```

```go title="main.go"
package main

import (
	"errors"
	"fmt"
	"os"

	"example.com/errdesign/check"
)

// timeoutError stands in for a network timeout, like the ones net/http returns.
type timeoutError struct{}

func (timeoutError) Error() string { return "i/o timeout" }
func (timeoutError) Timeout() bool { return true }

type fakeGetter map[string]int

func (f fakeGetter) Get(url string) (int, error) {
	if url == "https://slow.example/" {
		return 0, timeoutError{}
	}
	return f[url], nil
}

type timeouter interface {
	error
	Timeout() bool
}

// classify is the caller's side: it acts on the categories the package documents.
func classify(err error) string {
	switch {
	case err == nil:
		return "ok"
	case errors.Is(err, check.ErrBroken):
		return "broken"
	case errors.Is(err, check.ErrInvalidURL):
		return "invalid"
	}
	if t, ok := errors.AsType[timeouter](err); ok && t.Timeout() {
		return "retry later"
	}
	return "unknown failure"
}

func main() {
	g := fakeGetter{"https://go.dev/": 200, "https://go.dev/old": 404}
	links := []string{
		"https://go.dev/",
		"https://go.dev/old",
		"https://slow.example/",
		"ftp://files.example/a",
		"https://bad host/",
	}
	failures := 0
	for _, l := range links {
		err := check.Link(g, "https://go.dev/doc", l)
		fmt.Printf("%-16s %v\n", classify(err), err)
		if le, ok := errors.AsType[*check.LinkError](err); ok {
			fmt.Printf("%-16s found on %s\n", "", le.From)
			failures++
		}
	}
	// main is the one place that decides how the program ends.
	if failures > 0 {
		fmt.Fprintf(os.Stderr, "%d of %d links failed\n", failures, len(links))
		os.Exit(1)
	}
}
```

```bash
go run .
```

```text
ok               <nil>
broken           check https://go.dev/old (from https://go.dev/doc): status 404: broken link
                 found on https://go.dev/doc
retry later      check https://slow.example/ (from https://go.dev/doc): i/o timeout
                 found on https://go.dev/doc
invalid          check ftp://files.example/a (from https://go.dev/doc): invalid URL
                 found on https://go.dev/doc
invalid          check https://bad host/ (from https://go.dev/doc): invalid URL: parse "https://bad host/": invalid character " " in host name
                 found on https://go.dev/doc
4 of 5 links failed
exit status 1
```

## How the design answers the questions

- **What callers branch on.** A link checker's caller needs three categories: broken
  (report it), invalid (report it differently, it is the page author's typo), and network
  trouble (maybe retry). So the package exports two sentinels, `ErrBroken` and
  `ErrInvalidURL`, and lets network errors through unchanged so that a caller can test for
  a timeout behaviour ([[sentinel-typed]]). Nothing else is exported.
- **What data they need.** Every failure needs the URL and the page it came from, and
  broken links need the status. That is one error type, `*LinkError`, with an `Unwrap`
  method so the sentinels and network errors inside stay visible to `errors.Is` and
  `errors.AsType`. Categories are causes *inside* the one type, rather than one type per
  category; callers get both "what kind" and "which link" from any failure.
- **Dependency errors.** `url.Parse` returns a `*url.Error`. Wrapping it with `%w` would
  promise callers that a `*url.Error` is always in the chain, which ties the package to
  `net/url` forever. Instead `Link` wraps its own `ErrInvalidURL` with `%w` and includes
  the parser's message with `%v`: the human gets the detail, the program gets a stable
  sentinel. Network errors are the opposite case: callers have a real reason to inspect
  them (timeouts), so they are wrapped unchanged, and the doc comment says so.
- **Documentation.** The doc comment on `Link` lists exactly what it returns. Without it,
  callers cannot know which `errors.Is` checks are supported, and every implementation
  detail they discover by experiment becomes something you can never change.
- **Messages.** Each message reads from operation to cause, lower case, with no
  "failed to" ([[errors-as-values]]). The `check` prefix comes from the operation, not
  from repeating the package name at every layer.
- **Handled once.** `check.Link` never logs or exits; it returns. `main` is the only place
  that prints errors and chooses the exit status ([[exit-codes]]).

## Log or return, not both

The most common design mistake is handling an error twice: logging it *and* returning it.

```go title="main.go"
package main

import (
	"errors"
	"fmt"
	"log"
	"os"
)

func fetch(url string) error {
	err := errors.New("connection refused")
	log.Printf("fetch %s: %v", url, err)        // logs...
	return fmt.Errorf("fetch %s: %w", url, err) // ...and returns
}

func crawl(url string) error {
	if err := fetch(url); err != nil {
		log.Printf("crawl: %v", err) // logs again...
		return fmt.Errorf("crawl: %w", err)
	}
	return nil
}

func main() {
	log.SetFlags(0)
	log.SetOutput(os.Stdout)
	if err := crawl("https://go.dev/"); err != nil {
		log.Printf("linkcheck: %v", err) // ...and again
	}
}
```

```text
fetch https://go.dev/: connection refused
crawl: fetch https://go.dev/: connection refused
linkcheck: crawl: fetch https://go.dev/: connection refused
```

One failure, three log lines. In production that triples alert counts and makes every
incident look like a cascade. The layer that logs has also *handled* the error, so it
should not return it; the layer that returns it has not, so it should not log. Remove the
two inner `log.Printf` calls and the last line alone says everything.

> [!WARNING]
> Exporting every error "in case someone needs it", or wrapping every dependency error
> with `%w` by default. Symptom: you cannot change a database driver, HTTP client or parser
> without breaking a caller who matched its errors. Fix: export only the categories
> callers act on, document them on each function, and translate dependency errors at the
> package boundary.

> [!WARNING]
> Matching on error text, `strings.Contains(err.Error(), "404")`, because the package did
> not export what you need. Symptom: the check breaks when someone improves a message.
> Fix, as the package author: export a sentinel or type for that case. As a user: ask for
> one, and isolate the string match in one function until it exists.

| Decision | Choose |
|---|---|
| Callers only print it | Unexported error, good message |
| Callers branch on the kind | Exported sentinel `ErrX`, checked with `errors.Is` |
| Callers need details | Exported type `XError` with fields and `Unwrap`, checked with `errors.AsType` |
| Several kinds, all needing the same details | One type whose `Err` holds a sentinel |
| Callers need to ask a question (timeout?) | A behaviour method such as `Timeout() bool` |
| A dependency's error | `%w` only if you promise it; else `%v` or your own sentinel |
| Several independent failures | `errors.Join` ([[join]]) |
| A bug, not a failure | `panic`, recovered only at boundaries ([[panic-recover]]) |

linkcheck's `LinkError` in [[step-2-crawl]] is this design: a URL, a status and a wrapped
cause. Its reporters in [[step-7-reporters]] tell a bad status from a network error with
`errors.Is` and `errors.AsType`, much as `classify` does.
