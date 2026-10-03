---
title: "Step 7: reporters"
done_when: "`-format` accepts text, json, csv, junit and html, `-out` writes the report to a file, `-serve 127.0.0.1:8090` serves the HTML report until Ctrl-C, and `go test ./internal/report` passes against the five golden files."
---
linkcheck now writes its report in five formats behind one `Reporter` interface: grouped text, JSON, CSV, JUnit XML for CI systems, and an HTML page it can also serve over HTTP. The results reach every format as sorted iterators.

Do this yourself first, then compare.

1. Define `Reporter` with one method that writes to an `io.Writer`, and one implementation per format; pick one by name from a map ([[implicit-interfaces]], [[io-composition]], [[accept-interfaces]]).
2. Give `Result` a `Compare` method, and write `Sorted[T Comparer[T]]`, whose constraint refers to itself (Go 1.26) ([[self-constraints]], [[compare-sort]]).
3. Expose the results as `iter.Seq` values: `All` sorted with `slices.SortedFunc`, `Broken` through a generic `Filter` ([[writing-iterators]], [[slices-maps-pkgs]], [[type-parameters]]).
4. Write `BrokenBy`, a generic method (Go 1.27) that groups the broken links by any ordered key and yields the groups as an `iter.Seq2` ([[generic-methods]], [[constraints]], [[inference]]).
5. Write the text format through a `bufio.Writer` with `fmt` width verbs ([[bufio]], [[fmt-verbs]]).
6. Write JSON with tagged structs, `omitzero`, and an `Outcome` that marshals itself as text ([[json]], [[json-custom]]).
7. Write CSV with `encoding/csv` and `strconv`, and JUnit XML with struct tags for `encoding/xml` attributes and optional elements ([[csv]], [[strconv]], [[xml]], [[structs-embedding]]).
8. Write the HTML page with an embedded `html/template`, which escapes every URL for its context ([[templates]], [[embed]]).
9. Add `-out` (create the file, keep the error from `Close`) and `-serve` (an `http.Server` stopped with `Shutdown` on Ctrl-C) ([[os-files]], [[defer]], [[http-server]], [[signals]]).
10. Test every format against a golden file in `testdata`, rewritten with `-update` ([[golden-files]]).

## The code

New: `serve.go`, and the package `internal/report`: `report.go`, `text.go`, `json.go`, `csv.go`, `junit.go`, `html.go`, `report.html.tmpl`, `report_test.go` and five golden files in `testdata`. Changed: `main.go`, `internal/crawl/result.go`. Unchanged: `go.mod`, `go.sum`, `main_test.go`, `flags.go`, `config.go`, `preflight.go`, `progress.go`, `linkcheck.json`, every other file in `internal/crawl`, and `cmd/testsite`.

```go title="internal/crawl/result.go"
package crawl

import (
	"strings"
	"time"
)

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

// MarshalText makes an Outcome appear as "ok", "broken" or "excluded" in
// JSON and XML instead of as a number.
func (o Outcome) MarshalText() ([]byte, error) {
	return []byte(o.String()), nil
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

// Compare orders results by URL. It returns -1, 0 or +1, like
// strings.Compare.
func (r Result) Compare(other Result) int {
	return strings.Compare(r.URL, other.URL)
}
```

Two additions. `MarshalText` lets `encoding/json` and `encoding/xml` write an `Outcome` as `"broken"` rather than `1`, without any reporter converting it by hand. `Compare` gives results a natural order, by URL, in the same shape as `strings.Compare` and `cmp.Compare`.

```go title="internal/report/report.go"
// Package report renders the results of a crawl as text, JSON, CSV,
// JUnit XML or HTML.
package report

import (
	"cmp"
	"errors"
	"fmt"
	"io"
	"iter"
	"maps"
	"slices"
	"strings"
	"time"

	"example.com/linkcheck/internal/crawl"
)

// Report is everything a reporter needs to describe one crawl.
type Report struct {
	Starts      []string
	Started     time.Time
	Elapsed     time.Duration
	Interrupted bool // the crawl was stopped early; the results are partial
	Results     []crawl.Result
}

// A Reporter writes a report in one format.
type Reporter interface {
	Report(w io.Writer, r *Report) error
}

var reporters = map[string]Reporter{
	"text":  Text{},
	"json":  JSON{},
	"csv":   CSV{},
	"junit": JUnit{},
	"html":  HTML{},
}

// ByName returns the reporter for a format name such as "json".
func ByName(name string) (Reporter, error) {
	if r, ok := reporters[name]; ok {
		return r, nil
	}
	names := slices.Sorted(maps.Keys(reporters))
	return nil, fmt.Errorf("unknown format %q: want one of %s", name, strings.Join(names, ", "))
}

// Comparer is a type that can order its own values. The constraint
// mentions itself: T must have a method Compare(T) int.
type Comparer[T Comparer[T]] interface {
	Compare(T) int
}

// Sorted collects seq into a slice sorted by the values' own Compare
// method.
func Sorted[T Comparer[T]](seq iter.Seq[T]) []T {
	return slices.SortedFunc(seq, func(a, b T) int { return a.Compare(b) })
}

// Filter yields the values of seq for which keep returns true.
func Filter[T any](seq iter.Seq[T], keep func(T) bool) iter.Seq[T] {
	return func(yield func(T) bool) {
		for v := range seq {
			if keep(v) && !yield(v) {
				return
			}
		}
	}
}

// All yields every result, sorted by URL.
func (r *Report) All() iter.Seq[crawl.Result] {
	return slices.Values(Sorted(slices.Values(r.Results)))
}

// Broken yields the broken results, sorted by URL.
func (r *Report) Broken() iter.Seq[crawl.Result] {
	return Filter(r.All(), func(res crawl.Result) bool {
		return res.Outcome() == crawl.Broken
	})
}

// Count returns how many results have the outcome o.
func (r *Report) Count(o crawl.Outcome) int {
	n := 0
	for _, res := range r.Results {
		if res.Outcome() == o {
			n++
		}
	}
	return n
}

// Summary is the one-line count that ends every text report.
func (r *Report) Summary() string {
	excluded := r.Count(crawl.Excluded)
	return fmt.Sprintf("%d links checked, %d broken, %d excluded",
		len(r.Results)-excluded, r.Count(crawl.Broken), excluded)
}

// BrokenBy groups the broken results by key and yields the groups in key
// order, each sorted by URL. It is a generic method: K is chosen per call.
func (r *Report) BrokenBy[K cmp.Ordered](key func(crawl.Result) K) iter.Seq2[K, []crawl.Result] {
	groups := make(map[K][]crawl.Result)
	for res := range r.Broken() {
		k := key(res)
		groups[k] = append(groups[k], res)
	}
	return func(yield func(K, []crawl.Result) bool) {
		for _, k := range slices.Sorted(maps.Keys(groups)) {
			if !yield(k, groups[k]) {
				return
			}
		}
	}
}

// status is the HTTP status as text, "ERR" when no response arrived, or
// "-" for a link that was never requested.
func status(res crawl.Result) string {
	switch {
	case res.Outcome() == crawl.Excluded:
		return "-"
	case res.Status == 0:
		return "ERR"
	}
	return fmt.Sprint(res.Status)
}

// detail is the network error behind a broken link, or "" when the server
// answered with an error status (the status says it all).
func detail(res crawl.Result) string {
	le, ok := errors.AsType[*crawl.LinkError](res.Err)
	if !ok || errors.Is(le, crawl.ErrBadStatus) {
		return ""
	}
	return le.Err.Error()
}
```

How the pieces fit:

- `Comparer[T Comparer[T]]` is a constraint that mentions itself: "a type `T` with a method `Compare(T) int`". `crawl.Result` satisfies it with `Compare(Result) int`. A generic type whose own type parameter list refers to the type is allowed since Go 1.26.
- `Sorted` accepts any `iter.Seq` of such values and returns a sorted slice; `slices.SortedFunc` collects and sorts in one call. `All` wraps that slice back into an iterator with `slices.Values`, so every reporter sees the results in the same order without sorting them itself.
- `Filter` is an iterator adapter: it ranges over another iterator and yields only what `keep` accepts. It returns as soon as `yield` returns false, so a consumer that breaks out early stops the whole chain.
- `BrokenBy` is a generic method, new in Go 1.27: the receiver is the ordinary `*Report`, and `K` is chosen per call. The text reporter calls it with a `string` key (the parent page) and the test calls it with an `int` key (the depth); the compiler infers `K` from the function argument each time. A generic method cannot satisfy an interface method, which is why `Reporter.Report` itself is not generic.

```go title="internal/report/text.go"
package report

import (
	"bufio"
	"fmt"
	"io"

	"example.com/linkcheck/internal/crawl"
)

// Text writes the broken links grouped by the page they are on, then a
// summary line. It is the default format.
type Text struct{}

func (Text) Report(w io.Writer, r *Report) error {
	// bufio.Writer remembers the first write error and returns it from
	// Flush, so the Fprintf calls below need no error checks of their own.
	bw := bufio.NewWriter(w)
	for page, results := range r.BrokenBy(func(res crawl.Result) string { return res.Parent }) {
		if page == "" {
			page = "(start URLs)"
		}
		fmt.Fprintln(bw, page)
		for _, res := range results {
			fmt.Fprintf(bw, "  %-4s %s\n", status(res), res.URL)
			if d := detail(res); d != "" {
				fmt.Fprintf(bw, "       %s\n", d)
			}
		}
	}
	fmt.Fprintln(bw, r.Summary())
	if r.Interrupted {
		fmt.Fprintln(bw, "interrupted: this report is partial")
	}
	return bw.Flush()
}
```

```go title="internal/report/json.go"
package report

import (
	"encoding/json"
	"io"
	"time"

	"example.com/linkcheck/internal/crawl"
)

// JSON writes the whole report as one indented JSON object.
type JSON struct{}

type jsonReport struct {
	Starts      []string     `json:"starts"`
	Started     time.Time    `json:"started"`
	ElapsedMS   int64        `json:"elapsed_ms"`
	Interrupted bool         `json:"interrupted,omitzero"`
	Checked     int          `json:"checked"`
	Broken      int          `json:"broken"`
	Excluded    int          `json:"excluded"`
	Results     []jsonResult `json:"results"`
}

type jsonResult struct {
	URL        string        `json:"url"`
	Parent     string        `json:"parent,omitzero"`
	Depth      int           `json:"depth"`
	Status     int           `json:"status,omitzero"`
	Outcome    crawl.Outcome `json:"outcome"` // a string, through MarshalText
	Error      string        `json:"error,omitzero"`
	DurationMS int64         `json:"duration_ms,omitzero"`
}

func (JSON) Report(w io.Writer, r *Report) error {
	out := jsonReport{
		Starts:      r.Starts,
		Started:     r.Started,
		ElapsedMS:   r.Elapsed.Milliseconds(),
		Interrupted: r.Interrupted,
		Checked:     len(r.Results) - r.Count(crawl.Excluded),
		Broken:      r.Count(crawl.Broken),
		Excluded:    r.Count(crawl.Excluded),
		Results:     make([]jsonResult, 0, len(r.Results)),
	}
	for res := range r.All() {
		jr := jsonResult{
			URL:        res.URL,
			Parent:     res.Parent,
			Depth:      res.Depth,
			Status:     res.Status,
			Outcome:    res.Outcome(),
			DurationMS: res.Duration.Milliseconds(),
		}
		if res.Err != nil {
			jr.Error = res.Err.Error()
		}
		out.Results = append(out.Results, jr)
	}
	enc := json.NewEncoder(w)
	enc.SetIndent("", "  ")
	return enc.Encode(out)
}
```

`omitzero` (Go 1.24) leaves a field out when it holds its zero value: no `"parent"` on start URLs, no `"status"` when no response came, no `"interrupted": false` on complete crawls. `results` is created with `make(..., 0, n)` rather than left nil, so a crawl with no results encodes as `[]`, not `null`.

```go title="internal/report/csv.go"
package report

import (
	"encoding/csv"
	"io"
	"strconv"
)

// CSV writes one row per URL, for spreadsheets and scripts.
type CSV struct{}

func (CSV) Report(w io.Writer, r *Report) error {
	cw := csv.NewWriter(w)
	cw.Write([]string{"url", "parent", "depth", "status", "outcome", "error", "duration_ms"})
	for res := range r.All() {
		errText := ""
		if res.Err != nil {
			errText = res.Err.Error()
		}
		cw.Write([]string{
			res.URL,
			res.Parent,
			strconv.Itoa(res.Depth),
			strconv.Itoa(res.Status),
			res.Outcome().String(),
			errText,
			strconv.FormatInt(res.Duration.Milliseconds(), 10),
		})
	}
	// Write buffers; Flush sends the rows, and Error reports the first
	// error from any Write or Flush.
	cw.Flush()
	return cw.Error()
}
```

`csv.Writer` quotes a field only when it must: a URL containing a comma or a double quote is wrapped in quotes and the quote is doubled, as the `excluded` row in the golden file below shows.

```go title="internal/report/junit.go"
package report

import (
	"encoding/xml"
	"io"
	"strconv"
	"time"

	"example.com/linkcheck/internal/crawl"
)

// JUnit writes the report as JUnit XML, which CI systems display as a
// test run: each URL is a test case, each broken link a failure, each
// excluded link a skipped test.
type JUnit struct{}

type junitSuites struct {
	XMLName xml.Name     `xml:"testsuites"`
	Suites  []junitSuite `xml:"testsuite"`
}

type junitSuite struct {
	Name      string      `xml:"name,attr"`
	Tests     int         `xml:"tests,attr"`
	Failures  int         `xml:"failures,attr"`
	Skipped   int         `xml:"skipped,attr"`
	Time      string      `xml:"time,attr"`
	Timestamp string      `xml:"timestamp,attr"`
	Cases     []junitCase `xml:"testcase"`
}

type junitCase struct {
	Name      string        `xml:"name,attr"`
	Classname string        `xml:"classname,attr"`
	Time      string        `xml:"time,attr"`
	Failure   *junitFailure `xml:"failure,omitempty"`
	Skipped   *struct{}     `xml:"skipped,omitempty"`
}

type junitFailure struct {
	Message string `xml:"message,attr"`
	Type    string `xml:"type,attr"`
	Text    string `xml:",chardata"`
}

func seconds(d time.Duration) string {
	return strconv.FormatFloat(d.Seconds(), 'f', 3, 64)
}

func (JUnit) Report(w io.Writer, r *Report) error {
	suite := junitSuite{
		Name:      "linkcheck",
		Tests:     len(r.Results),
		Failures:  r.Count(crawl.Broken),
		Skipped:   r.Count(crawl.Excluded),
		Time:      seconds(r.Elapsed),
		Timestamp: r.Started.Format(time.RFC3339),
	}
	for res := range r.All() {
		c := junitCase{Name: res.URL, Classname: res.Parent, Time: seconds(res.Duration)}
		switch res.Outcome() {
		case crawl.Broken:
			c.Failure = &junitFailure{Message: status(res), Type: "broken", Text: res.Err.Error()}
		case crawl.Excluded:
			c.Skipped = &struct{}{}
		}
		suite.Cases = append(suite.Cases, c)
	}

	if _, err := io.WriteString(w, xml.Header); err != nil {
		return err
	}
	enc := xml.NewEncoder(w)
	enc.Indent("", "  ")
	if err := enc.Encode(junitSuites{Suites: []junitSuite{suite}}); err != nil {
		return err
	}
	_, err := io.WriteString(w, "\n")
	return err
}
```

Struct tags drive the XML: `,attr` makes a field an attribute, `,chardata` makes it the element's text, and a nil pointer with `omitempty` leaves the element out. A broken link becomes a `<failure>`, an excluded one a `<skipped>`, and a CI system that reads JUnit (GitHub Actions, GitLab, Jenkins) shows the crawl like a test run.

```go title="internal/report/html.go"
package report

import (
	_ "embed"
	"html/template"
	"io"
	"time"

	"example.com/linkcheck/internal/crawl"
)

// HTML writes a standalone web page with the broken links and every URL
// checked.
type HTML struct{}

//go:embed report.html.tmpl
var htmlSource string

// The template is parsed once, when the package loads. Must panics if it
// does not parse, which a test catches long before a user could.
var htmlTemplate = template.Must(template.New("report").Funcs(template.FuncMap{
	"status": status,
	"detail": detail,
	"ms":     func(res crawl.Result) int64 { return res.Duration.Milliseconds() },
	"round":  func(d time.Duration) time.Duration { return d.Round(time.Millisecond) },
}).Parse(htmlSource))

func (HTML) Report(w io.Writer, r *Report) error {
	return htmlTemplate.Execute(w, r)
}
```

```html title="internal/report/report.html.tmpl"
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>linkcheck report</title>
<style>
  body { font: 16px/1.5 system-ui, sans-serif; margin: 2rem auto; max-width: 70rem; padding: 0 1rem; }
  table { border-collapse: collapse; width: 100%; margin-bottom: 2rem; }
  th, td { text-align: left; padding: .25rem .5rem; border-bottom: 1px solid #ddd; vertical-align: top; }
  td { overflow-wrap: anywhere; }
  .broken { color: #b00020; }
  .excluded { color: #777; }
</style>
</head>
<body>
<h1>linkcheck report</h1>
<p>Started {{.Started.Format "2006-01-02 15:04:05 MST"}} from {{range $i, $s := .Starts}}{{if $i}}, {{end}}<a href="{{$s}}">{{$s}}</a>{{end}}.
{{.Summary}} in {{round .Elapsed}}.</p>
{{if .Interrupted}}<p class="broken"><strong>Interrupted: this report is partial.</strong></p>{{end}}

<h2>Broken links</h2>
<table>
<tr><th>Status</th><th>Link</th><th>Found on</th><th>Problem</th></tr>
{{range .Broken}}<tr class="broken">
  <td>{{status .}}</td>
  <td><a href="{{.URL}}">{{.URL}}</a></td>
  <td>{{with .Parent}}<a href="{{.}}">{{.}}</a>{{end}}</td>
  <td>{{detail .}}</td>
</tr>
{{else}}<tr><td colspan="4">None.</td></tr>
{{end}}</table>

<h2>Every URL</h2>
<table>
<tr><th>Status</th><th>Outcome</th><th>URL</th><th>Depth</th><th>ms</th></tr>
{{range .All}}<tr class="{{.Outcome}}">
  <td>{{status .}}</td>
  <td>{{.Outcome}}</td>
  <td><a href="{{.URL}}">{{.URL}}</a></td>
  <td>{{.Depth}}</td>
  <td>{{ms .}}</td>
</tr>
{{end}}</table>
</body>
</html>
```

`html/template` knows where each value lands. Inside `href="..."` it escapes a URL as a URL; inside a table cell it escapes `<`, `&` and quotes as HTML; and a `javascript:` URL in an `href` becomes `#ZgotmplZ`, a deliberately useless value. The link checker reports URLs that came from other people's pages, so this matters: `TestHTMLEscapesURLs` below pins it. `range .Broken` and `range .All` work because `text/template` and `html/template` range over `iter.Seq` values directly.

```go title="serve.go"
package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"time"

	"example.com/linkcheck/internal/report"
)

// serveReport serves the HTML report at http://addr/ until ctx is done
// (Ctrl-C), then shuts the server down gracefully.
func serveReport(ctx context.Context, addr string, rep *report.Report, stderr io.Writer) error {
	// Render once; every request gets the same bytes.
	var page bytes.Buffer
	if err := (report.HTML{}).Report(&page, rep); err != nil {
		return err
	}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /{$}", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Write(page.Bytes())
	})

	// Listen first, so the message shows the real address even for ":0".
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		return err
	}
	srv := &http.Server{Handler: mux, ReadHeaderTimeout: 5 * time.Second}
	fmt.Fprintf(stderr, "serving the report on http://%s/ (Ctrl-C to stop)\n", ln.Addr())

	errc := make(chan error, 1)
	go func() { errc <- srv.Serve(ln) }()
	select {
	case err := <-errc:
		return err
	case <-ctx.Done():
	}

	// Let requests in progress finish, but not forever.
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		return err
	}
	if err := <-errc; !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}
```

`-serve` renders the page once and serves the same bytes to every request. The pattern `GET /{$}` matches only the root path and only GET, so everything else is a 404 or 405 from the mux. On Ctrl-C, `Shutdown` stops accepting connections and waits up to five seconds for requests in progress; `Serve` then returns `http.ErrServerClosed`, which is the normal way for it to end and is not reported as an error.

```go title="main.go"
// Command linkcheck crawls a website and reports broken links.
package main

import (
	"cmp"
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"time"

	"example.com/linkcheck/internal/crawl"
	"example.com/linkcheck/internal/report"
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
	format    string
	out       string
	serve     string
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
	flag.StringVar(&cfg.format, "format", "text", "report `format`: text, json, csv, junit or html")
	flag.StringVar(&cfg.out, "out", "", "write the report to `file` instead of stdout")
	flag.StringVar(&cfg.serve, "serve", "", "after the crawl, serve the HTML report on `addr`, such as 127.0.0.1:8090")
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

	// cmp.Or returns its first non-zero argument: an empty format is text.
	reporter, err := report.ByName(cmp.Or(cfg.format, "text"))
	if err != nil {
		fmt.Fprintf(stderr, "linkcheck: %v\n", err)
		return exitError
	}

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
	started := time.Now()
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

	rep := &report.Report{
		Starts:      cfg.starts,
		Started:     started,
		Elapsed:     time.Since(started),
		Interrupted: interrupted,
		Results:     results,
	}
	if err := writeReport(reporter, rep, cfg.out, stdout); err != nil {
		fmt.Fprintf(stderr, "linkcheck: %v\n", err)
		return exitError
	}
	if cfg.serve != "" && !interrupted {
		if err := serveReport(ctx, cfg.serve, rep, stderr); err != nil {
			fmt.Fprintf(stderr, "linkcheck: serve: %v\n", err)
			return exitError
		}
	}

	switch {
	case interrupted:
		return exitInterrupted
	case rep.Count(crawl.Broken) > 0:
		return exitBroken
	}
	return exitOK
}

// writeReport writes the report to the file at path, or to stdout when
// path is empty.
func writeReport(reporter report.Reporter, rep *report.Report, path string, stdout io.Writer) (err error) {
	if path == "" {
		return reporter.Report(stdout, rep)
	}
	f, err := os.Create(path)
	if err != nil {
		return err
	}
	// A write error can surface only at Close, so its error must not be
	// dropped: keep it unless an earlier error is already being returned.
	defer func() {
		if cerr := f.Close(); err == nil {
			err = cerr
		}
	}()
	return reporter.Report(f, rep)
}
```

`writeReport` returns a named error so the deferred `Close` can set it. Writes to a file may be buffered by the operating system, so a full disk can surface only at `Close`; a plain `defer f.Close()` would throw that error away and report success.

### Tests and golden files

```go title="internal/report/report_test.go"
package report

import (
	"bytes"
	"errors"
	"flag"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"example.com/linkcheck/internal/crawl"
)

var update = flag.Bool("update", false, "rewrite the golden files in testdata")

// sample is a fixed report: every format is rendered from it and compared
// with a golden file.
func sample() *Report {
	home := "http://site.test/"
	return &Report{
		Starts:  []string{home},
		Started: time.Date(2026, 10, 3, 9, 30, 0, 0, time.UTC),
		Elapsed: 1250 * time.Millisecond,
		Results: []crawl.Result{
			{URL: home, Depth: 0, Status: 200, Duration: 12 * time.Millisecond},
			{URL: "http://site.test/missing.html", Parent: home, Depth: 1, Status: 404,
				Err:      &crawl.LinkError{URL: "http://site.test/missing.html", Status: 404, Err: crawl.ErrBadStatus},
				Duration: 3 * time.Millisecond},
			{URL: "http://down.test/", Parent: "http://site.test/about.html", Depth: 2,
				Err:      &crawl.LinkError{URL: "http://down.test/", Err: errors.New("connection refused")},
				Duration: 1 * time.Millisecond},
			{URL: "http://site.test/about.html", Parent: home, Depth: 1, Status: 200, Duration: 5 * time.Millisecond},
			{URL: "http://other.test/<b>&\"x\"", Parent: home, Depth: 1, Excluded: true},
		},
	}
}

func TestGolden(t *testing.T) {
	for name, rep := range reporters {
		t.Run(name, func(t *testing.T) {
			var buf bytes.Buffer
			if err := rep.Report(&buf, sample()); err != nil {
				t.Fatal(err)
			}
			golden := filepath.Join("testdata", name+".golden")
			if *update {
				if err := os.WriteFile(golden, buf.Bytes(), 0o644); err != nil {
					t.Fatal(err)
				}
			}
			want, err := os.ReadFile(golden)
			if err != nil {
				t.Fatalf("%v (run go test -update to create it)", err)
			}
			if got := buf.String(); got != string(want) {
				t.Errorf("output differs from %s; run go test -update and review the diff\ngot:\n%s", golden, got)
			}
		})
	}
}

func TestHTMLEscapesURLs(t *testing.T) {
	r := &Report{Results: []crawl.Result{{
		URL:    `javascript:alert("hi")`,
		Status: 404,
		Err:    &crawl.LinkError{Status: 404, Err: crawl.ErrBadStatus},
	}}}
	var buf bytes.Buffer
	if err := (HTML{}).Report(&buf, r); err != nil {
		t.Fatal(err)
	}
	out := buf.String()
	if strings.Contains(out, `href="javascript:`) {
		t.Error("a javascript: URL reached an href attribute")
	}
	if !strings.Contains(out, `href="#ZgotmplZ"`) {
		t.Error("expected html/template to replace the unsafe URL with #ZgotmplZ")
	}
}

func TestByName(t *testing.T) {
	if _, err := ByName("json"); err != nil {
		t.Fatal(err)
	}
	_, err := ByName("yaml")
	want := `unknown format "yaml": want one of csv, html, json, junit, text`
	if err == nil || err.Error() != want {
		t.Errorf("ByName(yaml) error = %v, want %q", err, want)
	}
}

func TestBrokenByGroupsInKeyOrder(t *testing.T) {
	var depths []int
	for depth, results := range sample().BrokenBy(func(r crawl.Result) int { return r.Depth }) {
		depths = append(depths, depth)
		if len(results) != 1 {
			t.Errorf("depth %d: %d results, want 1", depth, len(results))
		}
	}
	if len(depths) != 2 || depths[0] != 1 || depths[1] != 2 {
		t.Errorf("depths = %v, want [1 2]", depths)
	}
}
```

Each format is rendered from the same fixed `sample` report and compared byte for byte with `testdata/<format>.golden`. When you change a format on purpose, run `go test ./internal/report -update`, read the diff of the golden files in review, and commit them. The sample includes an excluded URL full of `<`, `&` and quotes, so the golden files also pin how each format escapes.

```text title="internal/report/testdata/text.golden"
http://site.test/
  404  http://site.test/missing.html
http://site.test/about.html
  ERR  http://down.test/
       connection refused
4 links checked, 2 broken, 1 excluded
```

```json title="internal/report/testdata/json.golden"
{
  "starts": [
    "http://site.test/"
  ],
  "started": "2026-10-03T09:30:00Z",
  "elapsed_ms": 1250,
  "checked": 4,
  "broken": 2,
  "excluded": 1,
  "results": [
    {
      "url": "http://down.test/",
      "parent": "http://site.test/about.html",
      "depth": 2,
      "outcome": "broken",
      "error": "http://down.test/: connection refused",
      "duration_ms": 1
    },
    {
      "url": "http://other.test/\u003cb\u003e\u0026\"x\"",
      "parent": "http://site.test/",
      "depth": 1,
      "outcome": "excluded"
    },
    {
      "url": "http://site.test/",
      "depth": 0,
      "status": 200,
      "outcome": "ok",
      "duration_ms": 12
    },
    {
      "url": "http://site.test/about.html",
      "parent": "http://site.test/",
      "depth": 1,
      "status": 200,
      "outcome": "ok",
      "duration_ms": 5
    },
    {
      "url": "http://site.test/missing.html",
      "parent": "http://site.test/",
      "depth": 1,
      "status": 404,
      "outcome": "broken",
      "error": "http://site.test/missing.html: 404 Not Found",
      "duration_ms": 3
    }
  ]
}
```

```csv title="internal/report/testdata/csv.golden"
url,parent,depth,status,outcome,error,duration_ms
http://down.test/,http://site.test/about.html,2,0,broken,http://down.test/: connection refused,1
"http://other.test/<b>&""x""",http://site.test/,1,0,excluded,,0
http://site.test/,,0,200,ok,,12
http://site.test/about.html,http://site.test/,1,200,ok,,5
http://site.test/missing.html,http://site.test/,1,404,broken,http://site.test/missing.html: 404 Not Found,3
```

```xml title="internal/report/testdata/junit.golden"
<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
  <testsuite name="linkcheck" tests="5" failures="2" skipped="1" time="1.250" timestamp="2026-10-03T09:30:00Z">
    <testcase name="http://down.test/" classname="http://site.test/about.html" time="0.001">
      <failure message="ERR" type="broken">http://down.test/: connection refused</failure>
    </testcase>
    <testcase name="http://other.test/&lt;b&gt;&amp;&#34;x&#34;" classname="http://site.test/" time="0.000">
      <skipped></skipped>
    </testcase>
    <testcase name="http://site.test/" classname="" time="0.012"></testcase>
    <testcase name="http://site.test/about.html" classname="http://site.test/" time="0.005"></testcase>
    <testcase name="http://site.test/missing.html" classname="http://site.test/" time="0.003">
      <failure message="404" type="broken">http://site.test/missing.html: 404 Not Found</failure>
    </testcase>
  </testsuite>
</testsuites>
```

```html title="internal/report/testdata/html.golden"
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>linkcheck report</title>
<style>
  body { font: 16px/1.5 system-ui, sans-serif; margin: 2rem auto; max-width: 70rem; padding: 0 1rem; }
  table { border-collapse: collapse; width: 100%; margin-bottom: 2rem; }
  th, td { text-align: left; padding: .25rem .5rem; border-bottom: 1px solid #ddd; vertical-align: top; }
  td { overflow-wrap: anywhere; }
  .broken { color: #b00020; }
  .excluded { color: #777; }
</style>
</head>
<body>
<h1>linkcheck report</h1>
<p>Started 2026-10-03 09:30:00 UTC from <a href="http://site.test/">http://site.test/</a>.
4 links checked, 2 broken, 1 excluded in 1.25s.</p>


<h2>Broken links</h2>
<table>
<tr><th>Status</th><th>Link</th><th>Found on</th><th>Problem</th></tr>
<tr class="broken">
  <td>ERR</td>
  <td><a href="http://down.test/">http://down.test/</a></td>
  <td><a href="http://site.test/about.html">http://site.test/about.html</a></td>
  <td>connection refused</td>
</tr>
<tr class="broken">
  <td>404</td>
  <td><a href="http://site.test/missing.html">http://site.test/missing.html</a></td>
  <td><a href="http://site.test/">http://site.test/</a></td>
  <td></td>
</tr>
</table>

<h2>Every URL</h2>
<table>
<tr><th>Status</th><th>Outcome</th><th>URL</th><th>Depth</th><th>ms</th></tr>
<tr class="broken">
  <td>ERR</td>
  <td>broken</td>
  <td><a href="http://down.test/">http://down.test/</a></td>
  <td>2</td>
  <td>1</td>
</tr>
<tr class="excluded">
  <td>-</td>
  <td>excluded</td>
  <td><a href="http://other.test/%3cb%3e&amp;%22x%22">http://other.test/&lt;b&gt;&amp;&#34;x&#34;</a></td>
  <td>1</td>
  <td>0</td>
</tr>
<tr class="ok">
  <td>200</td>
  <td>ok</td>
  <td><a href="http://site.test/">http://site.test/</a></td>
  <td>0</td>
  <td>12</td>
</tr>
<tr class="ok">
  <td>200</td>
  <td>ok</td>
  <td><a href="http://site.test/about.html">http://site.test/about.html</a></td>
  <td>1</td>
  <td>5</td>
</tr>
<tr class="broken">
  <td>404</td>
  <td>broken</td>
  <td><a href="http://site.test/missing.html">http://site.test/missing.html</a></td>
  <td>1</td>
  <td>3</td>
</tr>
</table>
</body>
</html>
```

## Run it

Create the golden files once, then run the whole suite:

```bash
go test ./internal/report -update
go test -count=1 ./...
```

```text
ok  	example.com/linkcheck	0.557s
?   	example.com/linkcheck/cmd/testsite	[no test files]
ok  	example.com/linkcheck/internal/crawl	0.814s
ok  	example.com/linkcheck/internal/report	0.508s
```

With the testsite running, the default text format now groups broken links by the page they are on:

```bash
go build .
./linkcheck http://127.0.0.1:8080/; echo "exit $?"
```

```text
http://127.0.0.1:8080/
  500  http://127.0.0.1:8080/error
  404  http://127.0.0.1:8080/missing.html
  404  http://127.0.0.1:8081/gone
  ERR  http://127.0.0.1:8099/
       dial tcp 127.0.0.1:8099: connectex: No connection could be made because the target machine actively refused it.
http://127.0.0.1:8080/about.html
  404  http://127.0.0.1:8080/team.html
http://127.0.0.1:8080/blog/post-1.html
  404  http://127.0.0.1:8080/blog/archive/2019.html
http://127.0.0.1:8080/blog/post-2.html
  404  http://127.0.0.1:8080/blog/drafts/
  ERR  https://127.0.0.1:8081/ok.html
       http: server gave HTTP response to HTTPS client
17 links checked, 8 broken, 0 excluded
exit 1
```

JSON, first lines (timestamps and durations differ per run):

```bash
./linkcheck -config linkcheck.json -depth 1 -format json | head -30
```

```json
{
  "starts": [
    "http://127.0.0.1:8080/"
  ],
  "started": "2026-10-03T14:41:58.59261+05:30",
  "elapsed_ms": 252,
  "checked": 7,
  "broken": 3,
  "excluded": 3,
  "results": [
    {
      "url": "http://127.0.0.1:8080/",
      "depth": 0,
      "status": 200,
      "outcome": "ok",
      "duration_ms": 8
    },
    {
      "url": "http://127.0.0.1:8080/about.html",
      "parent": "http://127.0.0.1:8080/",
      "depth": 1,
      "status": 200,
      "outcome": "ok"
    },
    {
      "url": "http://127.0.0.1:8080/blog/",
      "parent": "http://127.0.0.1:8080/",
      "depth": 1,
      "status": 200,
      "outcome": "ok"
```

`about.html` has no `duration_ms`: it took under a millisecond, which rounds to 0, and `omitzero` drops it.

CSV:

```bash
./linkcheck -config linkcheck.json -depth 1 -format csv
```

```csv
url,parent,depth,status,outcome,error,duration_ms
http://127.0.0.1:8080/,,0,200,ok,,13
http://127.0.0.1:8080/about.html,http://127.0.0.1:8080/,1,200,ok,,1
http://127.0.0.1:8080/blog/,http://127.0.0.1:8080/,1,200,ok,,0
http://127.0.0.1:8080/error,http://127.0.0.1:8080/,1,500,broken,http://127.0.0.1:8080/error: 500 Internal Server Error,0
http://127.0.0.1:8080/missing.html,http://127.0.0.1:8080/,1,404,broken,http://127.0.0.1:8080/missing.html: 404 Not Found,0
http://127.0.0.1:8080/old-page,http://127.0.0.1:8080/,1,200,ok,,0
http://127.0.0.1:8080/slow,http://127.0.0.1:8080/,1,0,excluded,,0
http://127.0.0.1:8081/gone,http://127.0.0.1:8080/,1,0,excluded,,0
http://127.0.0.1:8081/ok.html,http://127.0.0.1:8080/,1,0,excluded,,0
http://127.0.0.1:8099/,http://127.0.0.1:8080/,1,0,broken,http://127.0.0.1:8099/: dial tcp 127.0.0.1:8099: connectex: No connection could be made because the target machine actively refused it.,1
```

JUnit XML to a file, for a CI job to pick up:

```bash
./linkcheck -config linkcheck.json -depth 1 -format junit -out junit.xml; echo "exit $?"
head -12 junit.xml
```

```xml
<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
  <testsuite name="linkcheck" tests="10" failures="3" skipped="3" time="0.251" timestamp="2026-10-03T14:41:59+05:30">
    <testcase name="http://127.0.0.1:8080/" classname="" time="0.010"></testcase>
    <testcase name="http://127.0.0.1:8080/about.html" classname="http://127.0.0.1:8080/" time="0.000"></testcase>
    <testcase name="http://127.0.0.1:8080/blog/" classname="http://127.0.0.1:8080/" time="0.001"></testcase>
    <testcase name="http://127.0.0.1:8080/error" classname="http://127.0.0.1:8080/" time="0.001">
      <failure message="500" type="broken">http://127.0.0.1:8080/error: 500 Internal Server Error</failure>
    </testcase>
    <testcase name="http://127.0.0.1:8080/missing.html" classname="http://127.0.0.1:8080/" time="0.001">
      <failure message="404" type="broken">http://127.0.0.1:8080/missing.html: 404 Not Found</failure>
    </testcase>
```

The `echo` printed `exit 1` before `head` ran: the exit code still says "broken links", whatever the format.

Serve the HTML report. linkcheck crawls, prints the text summary, then serves the page until you press Ctrl-C:

```bash
./linkcheck -config linkcheck.json -depth 1 -serve 127.0.0.1:8090
```

```text
http://127.0.0.1:8080/
  500  http://127.0.0.1:8080/error
  404  http://127.0.0.1:8080/missing.html
  ERR  http://127.0.0.1:8099/
       dial tcp 127.0.0.1:8099: connectex: No connection could be made because the target machine actively refused it.
7 links checked, 3 broken, 3 excluded
serving the report on http://127.0.0.1:8090/ (Ctrl-C to stop)
```

Open `http://127.0.0.1:8090/` in a browser, or from another terminal:

```bash
curl -s http://127.0.0.1:8090/ | sed -n 17,20p
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8090/nope
```

```text
<h1>linkcheck report</h1>
<p>Started 2026-10-03 14:43:09 IST from <a href="http://127.0.0.1:8080/">http://127.0.0.1:8080/</a>.
7 links checked, 3 broken, 3 excluded in 254ms.</p>

404
```

Ctrl-C shuts the server down and linkcheck exits with 1, because the crawl it served found broken links.

Bad input is reported before any crawling, with status 2:

```bash
./linkcheck -format yaml http://127.0.0.1:8080/; echo "exit $?"
./linkcheck -out missing-dir/report.txt http://127.0.0.1:8080/about.html; echo "exit $?"
```

```text
linkcheck: unknown format "yaml": want one of csv, html, json, junit, text
exit 2
linkcheck: open missing-dir/report.txt: The system cannot find the path specified.
exit 2
```

The second message comes from Windows; on Linux and macOS it ends in `no such file or directory`. The output file is created after the crawl, so this error comes after a full crawl; [[step-10-ship]] is a good place to decide whether that is what you want.

> [!WARNING]
> Building the HTML page with `text/template`, or with `fmt.Fprintf` and string concatenation, works on the test site and breaks on the first real one. A link such as `<a href="/search?q=<b>">` or a `javascript:` URL from a crawled page would be pasted raw into your report and run in the browser of whoever opens it. Use `html/template` for anything a browser renders.

A crawl of a large site that is interrupted has to start again from nothing. [[step-8-state]] saves the crawl and resumes it.
