---
title: "Step 5: filters and config"
done_when: "`./linkcheck -config linkcheck.json` reports `13 links checked, 6 broken, 4 excluded` with no request to port 8081 or `/slow`, and a config file with an unknown field such as `dept` exits with status 2 and names the field."
---
linkcheck now skips links that match `-exclude` regular expressions, can limit itself to links that match `-include`, and reads its settings from a JSON config file that command-line flags override.

Do this yourself first, then compare.

1. Write `Filter` with `Include` and `Exclude` lists of compiled regular expressions, and apply it when the coordinator queues a link; compile each pattern once, when the flag is parsed ([[regexp]]).
2. Add `Excluded` to the `Outcome` constants and record skipped links as results, so the report can count them ([[constants-iota]]).
3. Write `regexpList`, a `flag.Value` that appends on every `Set`, so a flag can be repeated ([[flags-args]]).
4. Define the config file as a struct with `json` tags; use `*int` for numbers where 0 is a valid setting, so "not given" and "0" differ ([[json]], [[pointers]]).
5. Give `duration` `MarshalText` and `UnmarshalText`, so `"timeout": "1s"` decodes into a `time.Duration` ([[json-custom]], [[defined-types]]).
6. Open the file, close it with `defer`, and reject unknown fields with `DisallowUnknownFields` ([[os-files]], [[defer]]).
7. Apply the file first and let flags win: collect the flags the user actually set with `flag.Visit` ([[flags-args]]).

## The code

New: `config.go`, `linkcheck.json`, `internal/crawl/filter.go`. Changed: `main.go`, `flags.go`, `internal/crawl/result.go`, `internal/crawl/crawler.go`. Unchanged: `go.mod`, `go.sum`, `preflight.go`, `progress.go`, `internal/crawl/fetch.go`, `links.go`, `normalize.go`, `errors.go`, `set.go`, `limit.go`, and `cmd/testsite`.

```go title="internal/crawl/filter.go"
package crawl

import "regexp"

// Filter decides which links are checked. The zero value allows every
// link.
type Filter struct {
	Include []*regexp.Regexp // if not empty, a link must match one of these
	Exclude []*regexp.Regexp // a link that matches any of these is skipped
}

// Allow reports whether the link should be checked.
func (f *Filter) Allow(link string) bool {
	for _, re := range f.Exclude {
		if re.MatchString(link) {
			return false
		}
	}
	if len(f.Include) == 0 {
		return true
	}
	for _, re := range f.Include {
		if re.MatchString(link) {
			return true
		}
	}
	return false
}
```

Excludes are checked first, so a link that matches both lists is skipped. With no includes, everything not excluded is allowed. `MatchString` looks for a match anywhere in the URL; anchor the pattern with `^` or `$` when you mean the start or the end.

```go title="internal/crawl/result.go"
package crawl

import "time"

// Outcome classifies a checked link.
type Outcome int

const (
	OK       Outcome = iota // the link works
	Broken                  // the link returned an error status or no response
	Excluded                // a filter skipped the link; it was not requested
)

func (o Outcome) String() string {
	switch o {
	case OK:
		return "ok"
	case Broken:
		return "broken"
	case Excluded:
		return "excluded"
	}
	return "unknown"
}

// Result is what the crawler learned about one URL.
type Result struct {
	URL      string
	Parent   string // the page the link was first found on; "" for a start URL
	Depth    int    // clicks from the start URL
	Status   int    // HTTP status, or 0 if no response arrived
	Err      error  // a *LinkError when the link is broken
	Excluded bool   // a filter skipped the link

	Duration time.Duration // how long the request took
}

// Outcome reports whether the link works.
func (r Result) Outcome() Outcome {
	switch {
	case r.Excluded:
		return Excluded
	case r.Err != nil:
		return Broken
	}
	return OK
}
```

```go title="internal/crawl/crawler.go"
package crawl

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/url"
	"sync"
	"sync/atomic"
	"time"
)

// Crawler checks every link on a site, following links on the start URLs'
// hosts up to MaxDepth clicks away. Links to other hosts are checked but
// not followed.
type Crawler struct {
	Fetcher  *HTTPFetcher
	MaxDepth int
	Workers  int           // how many URLs to check at once; at least 1
	Logger   *slog.Logger  // nil means no logging
	Limiter  *HostLimiter  // nil means no rate limit
	Timeout  time.Duration // for one request, body included; 0 means none
	Filter   Filter        // which links to check; start URLs always are

	checked atomic.Int64 // URLs checked so far; read with Progress
	broken  atomic.Int64 // how many of those were broken
}

type job struct {
	url    string
	parent string
	depth  int
}

// done is what a worker sends back after visiting a job.
type done struct {
	res   Result
	links []string
}

// Run crawls from the start URLs and returns one Result per distinct URL,
// in the order the checks finished. The start URLs come first in the
// results only if they finish first; they have Depth 0 and no Parent.
//
// If ctx is cancelled, Run stops starting new checks, waits for its
// workers to exit, and returns the results gathered so far together with
// ctx.Err().
func (c *Crawler) Run(ctx context.Context, starts ...string) ([]Result, error) {
	var hosts, visited Set[string]
	var queue []job
	for _, start := range starts {
		u, err := url.Parse(start)
		if err != nil {
			return nil, err
		}
		first, err := Normalize(u, "")
		if err != nil {
			return nil, fmt.Errorf("%s: %w", start, err)
		}
		hosts.Add(u.Host)
		if visited.Add(first) {
			queue = append(queue, job{url: first})
		}
	}
	log := c.Logger
	if log == nil {
		log = slog.New(slog.DiscardHandler)
	}

	jobs := make(chan job)
	finished := make(chan done)
	var wg sync.WaitGroup
	for range max(c.Workers, 1) {
		wg.Go(func() {
			for j := range jobs {
				// hosts is never written after this point, so the
				// workers may read it concurrently.
				res, links := c.visit(ctx, j, &hosts)
				c.checked.Add(1)
				if res.Err != nil {
					c.broken.Add(1)
				}
				select {
				case finished <- done{res, links}:
				case <-ctx.Done():
					return
				}
			}
		})
	}

	inFlight := 0
	var results []Result

loop:
	for len(queue) > 0 || inFlight > 0 {
		// A nil channel blocks forever, so with an empty queue the send
		// case is switched off and select waits for results only.
		var send chan job
		var next job
		if len(queue) > 0 {
			send, next = jobs, queue[0]
		}
		select {
		case send <- next:
			queue = queue[1:]
			inFlight++
		case d := <-finished:
			inFlight--
			if ctx.Err() != nil {
				break loop // the check may have been cut short; drop it
			}
			results = append(results, d.res)
			log.Debug("checked", "url", d.res.URL, "status", d.res.Status,
				"depth", d.res.Depth, "took", d.res.Duration.Round(time.Millisecond))
			for _, link := range d.links {
				if !visited.Add(link) {
					continue
				}
				if !c.Filter.Allow(link) {
					results = append(results, Result{
						URL: link, Parent: d.res.URL, Depth: d.res.Depth + 1, Excluded: true,
					})
					continue
				}
				queue = append(queue, job{url: link, parent: d.res.URL, depth: d.res.Depth + 1})
			}
		case <-ctx.Done():
			break loop
		}
	}

	close(jobs)
	wg.Wait()
	if err := ctx.Err(); err != nil {
		log.Warn("crawl stopped", "checked", len(results), "queued", len(queue), "in_flight", inFlight)
		return results, err
	}
	return results, nil
}

// Progress reports how many URLs the workers have checked so far and how
// many of those were broken. It is safe to call from any goroutine while
// Run is running.
func (c *Crawler) Progress() (checked, broken int64) {
	return c.checked.Load(), c.broken.Load()
}

// visit checks one URL. If the URL is an HTML page on one of the start
// hosts and is not too deep, it also returns the links on the page.
func (c *Crawler) visit(ctx context.Context, j job, hosts *Set[string]) (Result, []string) {
	res := Result{URL: j.url, Parent: j.parent, Depth: j.depth}
	u, err := url.Parse(j.url)
	if err != nil {
		res.Err = &LinkError{URL: j.url, Err: err}
		return res, nil
	}
	if c.Limiter != nil {
		if err := c.Limiter.Wait(ctx, u.Host); err != nil {
			res.Err = &LinkError{URL: j.url, Err: err}
			return res, nil
		}
	}

	fetchCtx := ctx
	if c.Timeout > 0 {
		var cancel context.CancelFunc
		fetchCtx, cancel = context.WithTimeout(ctx, c.Timeout)
		defer cancel()
	}
	begin := time.Now()
	page, err := c.Fetcher.Fetch(fetchCtx, j.url)
	res.Duration = time.Since(begin)
	if err != nil {
		// The client wraps its errors in *url.Error, which repeats the
		// method and URL; keep only the cause.
		if ue, ok := errors.AsType[*url.Error](err); ok {
			err = ue.Err
		}
		// Our own deadline expired, not the caller's: say so plainly.
		if errors.Is(err, context.DeadlineExceeded) && ctx.Err() == nil {
			err = fmt.Errorf("%w after %v", ErrTimeout, c.Timeout)
		}
		res.Err = &LinkError{URL: j.url, Err: err}
		return res, nil
	}
	res.Status = page.Status
	if page.Status >= 400 {
		res.Err = &LinkError{URL: j.url, Status: page.Status, Err: ErrBadStatus}
		return res, nil
	}

	final, err := url.Parse(page.URL)
	if err != nil || !hosts.Has(final.Host) || !page.HTML() || j.depth >= c.MaxDepth {
		return res, nil
	}
	links, err := Links(final, bytes.NewReader(page.Body))
	if err != nil {
		return res, nil // a page that does not parse still loaded fine
	}
	return res, links
}
```

The filter runs in the coordinator, after `visited.Add`. An excluded link is still marked visited, so it is recorded once even if ten pages link to it, and it never reaches a worker. Start URLs bypass the filter: you asked for them by name.

```go title="flags.go"
package main

import (
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"

	"golang.org/x/time/rate"
)

// rateFlag is a request rate written as "N/PERIOD": "10/s", "30/m",
// "1/500ms". A bare number means per second, and "0" means no limit.
// It implements flag.Value.
type rateFlag struct {
	n   int
	per time.Duration
}

func (r *rateFlag) String() string {
	if r.n == 0 {
		return "0"
	}
	switch r.per {
	case time.Second:
		return fmt.Sprintf("%d/s", r.n)
	case time.Minute:
		return fmt.Sprintf("%d/m", r.n)
	}
	return fmt.Sprintf("%d/%v", r.n, r.per)
}

func (r *rateFlag) Set(s string) error {
	count, period, found := strings.Cut(s, "/")
	n, err := strconv.Atoi(count)
	if err != nil || n < 0 {
		return errors.New("want N/PERIOD, such as 10/s, 30/m or 1/500ms")
	}
	per := time.Second
	if found {
		switch period {
		case "s":
		case "m":
			per = time.Minute
		default:
			per, err = time.ParseDuration(period)
			if err != nil || per <= 0 {
				return fmt.Errorf("bad period %q: want s, m or a duration such as 500ms", period)
			}
		}
	}
	r.n, r.per = n, per
	return nil
}

// Limit converts the flag to a rate.Limit in events per second.
func (r *rateFlag) Limit() rate.Limit {
	if r.n == 0 {
		return rate.Inf
	}
	return rate.Limit(float64(r.n) / r.per.Seconds())
}

// regexpList collects a regular expression each time the flag is given:
// -exclude a -exclude b. It implements flag.Value.
type regexpList []*regexp.Regexp

func (l *regexpList) String() string {
	var s []string
	for _, re := range *l {
		s = append(s, re.String())
	}
	return strings.Join(s, " ")
}

func (l *regexpList) Set(s string) error {
	re, err := regexp.Compile(s)
	if err != nil {
		return err
	}
	*l = append(*l, re)
	return nil
}
```

`regexp.Compile` runs once per pattern, when the flag is parsed. A bad pattern fails at startup with the parser's message instead of at the first link, and the crawl never compiles a pattern in its hot loop.

```go title="config.go"
package main

import (
	"encoding/json"
	"fmt"
	"os"
	"time"
)

// fileConfig is the JSON config file given with -config. Every field is
// optional, and a flag given on the command line wins over the file.
type fileConfig struct {
	Start     []string `json:"start"`
	Depth     *int     `json:"depth"` // a pointer, so "depth": 0 differs from no depth
	Workers   *int     `json:"workers"`
	Rate      string   `json:"rate"`
	Timeout   duration `json:"timeout"`
	UserAgent string   `json:"user_agent"`
	Include   []string `json:"include"`
	Exclude   []string `json:"exclude"`
}

// duration is a time.Duration written in JSON as a string such as "5s".
type duration time.Duration

func (d duration) MarshalText() ([]byte, error) {
	return []byte(time.Duration(d).String()), nil
}

func (d *duration) UnmarshalText(b []byte) error {
	v, err := time.ParseDuration(string(b))
	if err != nil {
		return err
	}
	*d = duration(v)
	return nil
}

// loadConfig reads a config file. Unknown fields are an error, so a typo
// such as "dept" is reported instead of silently ignored.
func loadConfig(path string) (*fileConfig, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()

	dec := json.NewDecoder(f)
	dec.DisallowUnknownFields()
	var fc fileConfig
	if err := dec.Decode(&fc); err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	return &fc, nil
}

// apply copies the file's settings into cfg, except for the flags named in
// set, which the user gave on the command line.
func (fc *fileConfig) apply(cfg *config, set map[string]bool) error {
	if len(fc.Start) > 0 && len(cfg.starts) == 0 {
		cfg.starts = fc.Start
	}
	if fc.Depth != nil && !set["depth"] {
		cfg.depth = *fc.Depth
	}
	if fc.Workers != nil && !set["workers"] {
		cfg.workers = *fc.Workers
	}
	if fc.Rate != "" && !set["rate"] {
		if err := cfg.rate.Set(fc.Rate); err != nil {
			return fmt.Errorf("rate: %w", err)
		}
	}
	if fc.Timeout != 0 && !set["timeout"] {
		cfg.timeout = time.Duration(fc.Timeout)
	}
	if fc.UserAgent != "" && !set["user-agent"] {
		cfg.userAgent = fc.UserAgent
	}
	if !set["include"] {
		for _, s := range fc.Include {
			if err := cfg.include.Set(s); err != nil {
				return fmt.Errorf("include: %w", err)
			}
		}
	}
	if !set["exclude"] {
		for _, s := range fc.Exclude {
			if err := cfg.exclude.Set(s); err != nil {
				return fmt.Errorf("exclude: %w", err)
			}
		}
	}
	return nil
}
```

`json.Decoder` maps `"user_agent"` to the field tagged `json:"user_agent"`. Without a tag it would match the field name case-insensitively (`UserAgent`, `useragent`), which is rarely what a config file should accept.

`duration` is a defined type over `time.Duration`, so it can have methods of its own. `encoding/json` uses `UnmarshalText` for a JSON string when the target implements `encoding.TextUnmarshaler`, so a duration is written as `"1s"`, not as the 1000000000 nanoseconds a plain `time.Duration` would require.

> [!NOTE]
> Since Go 1.27, `encoding/json` runs on the `encoding/json/v2` implementation. Behaviour is preserved, but the exact text of error messages may differ from older releases, so match on error values and types, not on message strings.

```go title="main.go"
// Command linkcheck crawls a website and reports broken links.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"slices"
	"strings"
	"time"

	"example.com/linkcheck/internal/crawl"
)

// Exit codes.
const (
	exitOK          = 0   // every link works
	exitBroken      = 1   // at least one link is broken
	exitError       = 2   // linkcheck could not run
	exitInterrupted = 130 // stopped by Ctrl-C; the report is partial
)

// config holds the settings from the command line.
type config struct {
	starts    []string
	depth     int
	workers   int
	verbose   bool
	rate      rateFlag
	timeout   time.Duration
	checkTCP  bool
	userAgent string
	include   regexpList
	exclude   regexpList
}

func main() {
	cfg := config{rate: rateFlag{n: 10, per: time.Second}}
	flag.IntVar(&cfg.depth, "depth", 3, "follow links up to `n` clicks from the start page")
	flag.IntVar(&cfg.workers, "workers", 8, "check up to `n` links at once")
	flag.BoolVar(&cfg.verbose, "v", false, "log every check to stderr")
	flag.Var(&cfg.rate, "rate", "at most `N/PERIOD` requests to each host, such as 10/s or 30/m; 0 for no limit")
	flag.DurationVar(&cfg.timeout, "timeout", 10*time.Second, "give up on a request after `d`")
	flag.BoolVar(&cfg.checkTCP, "check-tcp", false, "connect to each start host before crawling")
	flag.StringVar(&cfg.userAgent, "user-agent", "linkcheck/dev", "User-Agent header to send")
	flag.Var(&cfg.include, "include", "only check links matching `regexp` (repeatable)")
	flag.Var(&cfg.exclude, "exclude", "skip links matching `regexp` (repeatable)")
	configPath := flag.String("config", "", "read settings from the JSON `file`; flags win")
	flag.Usage = func() {
		fmt.Fprintln(flag.CommandLine.Output(), "usage: linkcheck [flags] URL...")
		flag.PrintDefaults()
	}
	flag.Parse()
	cfg.starts = flag.Args()
	if *configPath != "" {
		set := make(map[string]bool)
		flag.Visit(func(f *flag.Flag) { set[f.Name] = true })
		fc, err := loadConfig(*configPath)
		if err == nil {
			err = fc.apply(&cfg, set)
		}
		if err != nil {
			fmt.Fprintf(os.Stderr, "linkcheck: config: %v\n", err)
			os.Exit(exitError)
		}
	}
	if len(cfg.starts) == 0 {
		flag.Usage()
		os.Exit(exitError)
	}

	// The first Ctrl-C cancels ctx; stop restores the default behaviour,
	// so a second Ctrl-C kills the process at once.
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	code := run(ctx, cfg, os.Stdout, os.Stderr)
	stop()
	os.Exit(code)
}

func run(ctx context.Context, cfg config, stdout, stderr io.Writer) int {
	level := slog.LevelWarn
	if cfg.verbose {
		level = slog.LevelDebug
	}
	logger := slog.New(slog.NewTextHandler(stderr, &slog.HandlerOptions{Level: level}))

	if cfg.checkTCP {
		if err := checkTCP(ctx, cfg.starts, cfg.timeout); err != nil {
			fmt.Fprintf(stderr, "linkcheck: %v\n", err)
			return exitError
		}
	}

	c := &crawl.Crawler{
		Fetcher: &crawl.HTTPFetcher{
			Client:    &http.Client{},
			UserAgent: cfg.userAgent,
		},
		MaxDepth: cfg.depth,
		Workers:  cfg.workers,
		Logger:   logger,
		Limiter:  &crawl.HostLimiter{Limit: cfg.rate.Limit(), Burst: 1},
		Timeout:  cfg.timeout,
		Filter:   crawl.Filter{Include: cfg.include, Exclude: cfg.exclude},
	}
	stopProgress := func() {}
	if cfg.verbose {
		stopProgress = logProgress(logger, c)
	}
	results, err := c.Run(ctx, cfg.starts...)
	stopProgress()
	interrupted := errors.Is(err, context.Canceled)
	if err != nil && !interrupted {
		fmt.Fprintf(stderr, "linkcheck: %v\n", err)
		return exitError
	}
	if len(results) == 0 {
		fmt.Fprintln(stderr, "linkcheck: interrupted before a start page loaded")
		return exitInterrupted
	}
	for _, r := range results {
		if r.Depth == 0 && r.Err != nil {
			fmt.Fprintf(stderr, "linkcheck: start page: %v\n", r.Err)
			return exitError
		}
	}

	// Workers finish in any order; sort so the report is stable.
	slices.SortFunc(results, func(a, b crawl.Result) int {
		return strings.Compare(a.URL, b.URL)
	})
	broken, excluded := 0, 0
	for _, r := range results {
		switch r.Outcome() {
		case crawl.Broken:
			broken++
			printBroken(stdout, r)
		case crawl.Excluded:
			excluded++
		}
	}
	fmt.Fprintf(stdout, "%d links checked, %d broken, %d excluded\n", len(results)-excluded, broken, excluded)
	switch {
	case interrupted:
		fmt.Fprintln(stdout, "interrupted: this report is partial")
		return exitInterrupted
	case broken > 0:
		return exitBroken
	}
	return exitOK
}

// printBroken prints a broken link, the page it is on, and the network
// error if there was no HTTP response.
func printBroken(w io.Writer, r crawl.Result) {
	status := "ERR"
	if r.Status != 0 {
		status = fmt.Sprint(r.Status)
	}
	fmt.Fprintf(w, "%-4s %s\n", status, r.URL)
	fmt.Fprintf(w, "     on %s\n", r.Parent)
	if le, ok := errors.AsType[*crawl.LinkError](r.Err); ok && !errors.Is(le, crawl.ErrBadStatus) {
		fmt.Fprintf(w, "     %v\n", le.Err)
	}
}
```

```json title="linkcheck.json"
{
  "start": ["http://127.0.0.1:8080/"],
  "depth": 3,
  "rate": "20/s",
  "timeout": "1s",
  "user_agent": "linkcheck (testsite crawl)",
  "exclude": [
    "^https?://127\\.0\\.0\\.1:8081/",
    "/slow$"
  ]
}
```

In JSON a backslash must itself be escaped, so the regular expression `^https?://127\.0\.0\.1:8081/` is written with doubled backslashes.

## Run it

With the testsite running, use the config file. It skips the partner site and `/slow`, and gives each request one second:

```bash
go build .
./linkcheck -config linkcheck.json; echo "exit $?"
```

```text
404  http://127.0.0.1:8080/blog/archive/2019.html
     on http://127.0.0.1:8080/blog/post-1.html
404  http://127.0.0.1:8080/blog/drafts/
     on http://127.0.0.1:8080/blog/post-2.html
500  http://127.0.0.1:8080/error
     on http://127.0.0.1:8080/
404  http://127.0.0.1:8080/missing.html
     on http://127.0.0.1:8080/
404  http://127.0.0.1:8080/team.html
     on http://127.0.0.1:8080/about.html
ERR  http://127.0.0.1:8099/
     on http://127.0.0.1:8080/
     dial tcp 127.0.0.1:8099: connectex: No connection could be made because the target machine actively refused it.
13 links checked, 6 broken, 4 excluded
exit 1
```

The four excluded links are the three on port 8081 (`ok.html`, `gone`, and the `https` one from `post-2.html`) and `/slow`. No URL came from the command line: the start URL is in the file.

A flag overrides the file. Here `-include` limits the crawl to the blog, while the file's excludes still apply because `-exclude` was not given:

```bash
./linkcheck -config linkcheck.json -include 'blog/'; echo "exit $?"
```

```text
404  http://127.0.0.1:8080/blog/archive/2019.html
     on http://127.0.0.1:8080/blog/post-1.html
404  http://127.0.0.1:8080/blog/drafts/
     on http://127.0.0.1:8080/blog/post-2.html
6 links checked, 2 broken, 9 excluded
exit 1
```

> [!NOTE]
> In Git Bash on Windows, an argument that starts with `/` is rewritten into a Windows path before the program sees it: `-include '/blog/'` arrives as `C:/Program Files/Git/blog/` and matches nothing. Write the pattern without the leading slash, or set `MSYS_NO_PATHCONV=1`.

Flags alone work too, and repeat:

```bash
./linkcheck -depth 1 -exclude ':8081/' -exclude 'slow' http://127.0.0.1:8080/
```

```text
500  http://127.0.0.1:8080/error
     on http://127.0.0.1:8080/
404  http://127.0.0.1:8080/missing.html
     on http://127.0.0.1:8080/
ERR  http://127.0.0.1:8099/
     on http://127.0.0.1:8080/
     dial tcp 127.0.0.1:8099: connectex: No connection could be made because the target machine actively refused it.
7 links checked, 3 broken, 3 excluded
```

A typo in the config file is an error, not a silently ignored setting:

```bash
echo '{"dept": 2}' > typo.json
./linkcheck -config typo.json; echo "exit $?"
```

```text
linkcheck: config: typo.json: json: unknown field "dept"
exit 2
```

So is a bad pattern on the command line. The flag package reports the error from `regexp.Compile` and prints the usage (shortened here):

```bash
./linkcheck -exclude '[' http://127.0.0.1:8080/
```

```text
invalid value "[" for flag -exclude: error parsing regexp: missing closing ]: `[`
usage: linkcheck [flags] URL...
```

> [!WARNING]
> `regexp.MustCompile` inside `Allow` would compile every pattern for every link: correct, and many times slower on a large crawl. It also panics on a bad pattern in the middle of a run instead of failing at startup. Compile once, at the edge, and keep the `*regexp.Regexp` values; they are safe for concurrent use.

The code has grown past what you can check by running it against one test site. [[step-6-tests]] locks the behaviour down with tests before the larger changes to come.
