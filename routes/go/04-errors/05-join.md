---
title: Joining errors
done_when: "A validation function of yours reports every problem at once with errors.Join, returns nil when there are none, and callers still find each cause with errors.Is and errors.AsType."
---
Sometimes one operation fails in several independent ways: a config file with three bad
fields, a write that fails and then a close that fails too, a batch of URLs where five are
broken. Returning only the first error hides the rest, and the user fixes one problem per
run. **`errors.Join`** (Go 1.20) combines several errors into one error value that still
exposes each of them to `errors.Is` and `errors.As`.

```go title="main.go"
package main

import (
	"errors"
	"fmt"
	"net/url"
	"strings"
)

var ErrEmpty = errors.New("empty value")

type Config struct {
	StartURL string
	Workers  int
	Exclude  []string
}

// Validate reports every problem, not just the first.
func (c Config) Validate() error {
	var errs []error
	if c.StartURL == "" {
		errs = append(errs, fmt.Errorf("start_url: %w", ErrEmpty))
	} else if _, err := url.ParseRequestURI(c.StartURL); err != nil {
		errs = append(errs, fmt.Errorf("start_url: %w", err))
	}
	if c.Workers < 1 || c.Workers > 64 {
		errs = append(errs, fmt.Errorf("workers: %d is outside 1..64", c.Workers))
	}
	for i, pat := range c.Exclude {
		if strings.TrimSpace(pat) == "" {
			errs = append(errs, fmt.Errorf("exclude[%d]: %w", i, ErrEmpty))
		}
	}
	return errors.Join(errs...) // nil when errs is empty or all nil
}

func main() {
	good := Config{StartURL: "https://go.dev/", Workers: 8}
	fmt.Println("good:", good.Validate())

	bad := Config{StartURL: "go.dev", Workers: 0, Exclude: []string{"/blog", " "}}
	err := bad.Validate()
	fmt.Printf("bad (%T):\n%v\n", err, err)

	fmt.Println("errors.Unwrap:", errors.Unwrap(err))
	fmt.Println("errors.Is ErrEmpty:", errors.Is(err, ErrEmpty))
	if ue, ok := errors.AsType[*url.Error](err); ok {
		fmt.Printf("url.Error: op=%s url=%q\n", ue.Op, ue.URL)
	}

	// The children, for one-line logs or per-field display.
	if j, ok := err.(interface{ Unwrap() []error }); ok {
		parts := []string{}
		for _, e := range j.Unwrap() {
			parts = append(parts, e.Error())
		}
		fmt.Println("one line:", strings.Join(parts, "; "))
	}

	fmt.Println("Join(nil, nil) == nil:", errors.Join(nil, nil) == nil)
	single := errors.Join(ErrEmpty)
	fmt.Println("Join(ErrEmpty) == ErrEmpty:", single == ErrEmpty, " Is:", errors.Is(single, ErrEmpty))
}
```

```bash
go run .
```

```text
good: <nil>
bad (*errors.joinError):
start_url: parse "go.dev": invalid URI for request
workers: 0 is outside 1..64
exclude[1]: empty value
errors.Unwrap: <nil>
errors.Is ErrEmpty: true
url.Error: op=parse url="go.dev"
one line: start_url: parse "go.dev": invalid URI for request; workers: 0 is outside 1..64; exclude[1]: empty value
Join(nil, nil) == nil: true
Join(ErrEmpty) == ErrEmpty: false  Is: true
```

## How it works

The rules, from the `errors` package documentation, each visible in the output:

- **Nil errors are discarded**, and **`Join` returns nil if every argument is nil** (or
  there are none). So `return errors.Join(errs...)` is correct whether `errs` is empty or
  not; you do not need an `if len(errs) > 0` around it. `good.Validate()` printed `<nil>`.
- **The message is each error's message, separated by newlines.** That is readable in a
  terminal and awkward in a one-line log; build your own format from the children when
  you need one, as the "one line" output does.
- **The result has `Unwrap() []error`**, not `Unwrap() error`. `errors.Unwrap` only calls
  the single form, so it returns `nil`. `errors.Is` and `errors.As`/`AsType` search every
  child depth-first ([[is-as]]), which is why both `ErrEmpty` (inside the third child) and
  the `*url.Error` (inside the first) were found.
- **`Join` always returns a new value** when at least one error is non-nil, even for a
  single error. `errors.Join(ErrEmpty) == ErrEmpty` is false; `errors.Is` is true. One more
  reason to never compare errors with `==`.

`errors.Join` and `fmt.Errorf` with several `%w` ([[wrapping]]) produce the same kind of
tree. Use `Join` for a list of independent failures; use multiple `%w` when one message
explains how the errors relate ("give up: retries exhausted after i/o timeout").

## Joining an operation's error with its cleanup's

The other common use is reporting a failed operation *and* a failed cleanup. A file
write can succeed while `Close` fails (some file systems, NFS for example, report write
errors only when the file is closed), and that failure means data was lost:

```go title="main.go"
package main

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

// save writes data and always closes the file, reporting both failures if both happen.
func save(path string, data []byte) error {
	f, err := os.Create(path)
	if err != nil {
		return err
	}
	_, writeErr := f.Write(data)
	closeErr := f.Close()
	return errors.Join(writeErr, closeErr)
}

func main() {
	path := filepath.Join(os.TempDir(), "report.txt")
	fmt.Println("save:", save(path, []byte("ok\n")))
	os.Remove(path)

	// Joining inside a loop nests: each Join wraps the previous one.
	var nested error
	for i := 0; i < 3; i++ {
		nested = errors.Join(nested, fmt.Errorf("problem %d", i))
	}
	var flat []error
	for i := 0; i < 3; i++ {
		flat = append(flat, fmt.Errorf("problem %d", i))
	}
	joined := errors.Join(flat...)

	fmt.Printf("same text: %t\n", nested.Error() == joined.Error())
	fmt.Println("top-level children, nested:", len(nested.(interface{ Unwrap() []error }).Unwrap()))
	fmt.Println("top-level children, flat:  ", len(joined.(interface{ Unwrap() []error }).Unwrap()))
}
```

```text
save: <nil>
same text: true
top-level children, nested: 2
top-level children, flat:   3
```

`errors.Join(writeErr, closeErr)` covers all four cases in one line: both nil gives nil,
either one alone gives that error (in a join), both give both. The usual form of this
puts `Close` in a `defer` and joins into a named result; [[defer]] shows it.

The second half shows a quieter problem. `err = errors.Join(err, e)` in a loop builds a
join inside a join inside a join. The text is identical and `errors.Is` still works, but
the top level has two children instead of three, so code that lists the children (to show
one problem per form field, or count them) gets the wrong answer. Collect into a slice and
join once.

> [!WARNING]
> Logging a joined error on one line, for example with `log.Printf("config: %v", err)`,
> splits one log record across several lines. Symptom: log search and alerting see the
> second and later problems as separate, unprefixed entries. Fix: in logs, format the
> children yourself, or log the error as a structured attribute: slog's text handler
> writes it as one quoted value, `err="a\nb"` ([[slog]]).

> [!NOTE]
> Before Go 1.20 people used third-party packages such as `go.uber.org/multierr` for this.
> New code needs only `errors.Join`.

linkcheck does not join errors: its config loader in [[step-5-filters]] returns the first
error, with the file name wrapped around it, so a typo is reported one at a time.
