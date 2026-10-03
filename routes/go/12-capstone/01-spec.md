---
title: The spec
---
You will build `linkcheck`, a command-line tool that crawls a website and reports broken links. You give it one or more start URLs. It fetches each page, finds every `<a href>` link, checks each one with an HTTP request, follows the links that stay on the start hosts up to a maximum depth, and reports what is broken and where it was found. It exits with a status a script or a CI job can act on.

The project is module `example.com/linkcheck`, grown over ten steps from one page checked in a loop to a concurrent, rate-limited, resumable crawler with five report formats, a test suite, measured performance and release binaries for four platforms. Each step adds to the code of the step before; none throws work away.

## The test site

Every run in this capstone crawls a small site you serve yourself, so the output is the same on every machine and no one else's server is involved. It is part of the module, under `cmd/testsite`, and you write it in [[step-1-single-page]]:

| Address | What it serves |
|---|---|
| `http://127.0.0.1:8080/` | A home page, an about page and its byte-for-byte copy, a blog with two posts |
| `/missing.html`, `/team.html`, `/blog/archive/2019.html`, `/blog/drafts/` | 404s, linked from various pages |
| `/old-page` | A 301 redirect to `/about.html` |
| `/error` | A 500 |
| `/slow` | A page that takes three seconds |
| `http://127.0.0.1:8081/` | A second "partner" site: `/ok.html` works, everything else is 404 |
| `http://127.0.0.1:8099/` | Nothing listens here: the connection is refused |
| `https://127.0.0.1:8081/ok.html` | An `https` link to a site that only speaks HTTP |

Start it once with `go run ./cmd/testsite` and leave it running.

## Usage

```text
linkcheck [flags] URL...
```

| Flag | Default | Does | Added in |
|---|---|---|---|
| `-depth n` | `3` | Follow links up to `n` clicks from a start page | [[step-2-crawl]] |
| `-workers n` | `8` | Check up to `n` links at once | [[step-3-concurrent]] |
| `-v` | off | Log every check and the progress counters to stderr | [[step-3-concurrent]] |
| `-rate N/PERIOD` | `10/s` | At most this many requests per host, such as `2/s`, `30/m`, `1/500ms`; `0` for no limit | [[step-4-polite]] |
| `-timeout d` | `10s` | Give up on one request after `d` | [[step-4-polite]] |
| `-check-tcp` | off | Connect to every start host before crawling | [[step-4-polite]] |
| `-user-agent s` | `linkcheck/<version>` | User-Agent header to send | [[step-4-polite]] |
| `-include regexp` | none | Only check links matching one of these (repeatable) | [[step-5-filters]] |
| `-exclude regexp` | none | Skip links matching any of these (repeatable) | [[step-5-filters]] |
| `-config file` | none | Read settings from a JSON file; flags win over the file | [[step-5-filters]] |
| `-format f` | `text` | Report as `text`, `json`, `csv`, `junit` or `html` | [[step-7-reporters]] |
| `-out file` | stdout | Write the report to a file | [[step-7-reporters]] |
| `-serve addr` | off | After the crawl, serve the HTML report until Ctrl-C | [[step-7-reporters]] |
| `-state file` | off | Resume from the file if it exists; save to it on Ctrl-C | [[step-8-state]] |
| `-pprof addr` | off | Serve live runtime profiles | [[step-9-profile]] |
| `-open` | off | Write the HTML report and open it in the browser | [[step-10-ship]] |
| `-version` | | Print the version and exit | [[step-10-ship]] |

A config file holds the same settings:

```json
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

## Exit status

| Status | Meaning |
|---|---|
| `0` | Every checked link works |
| `1` | At least one link is broken |
| `2` | linkcheck could not run: bad flag or config, unreachable start page, unwritable output |
| `130` | Interrupted with Ctrl-C; the report printed is partial |

## Output

The default text report groups broken links by the page they are on, lists pages with identical content, and ends with a summary line. This is the finished tool against the test site:

```text
http://127.0.0.1:8080/
  500  http://127.0.0.1:8080/error
  404  http://127.0.0.1:8080/missing.html
  404  http://127.0.0.1:8081/gone
  ERR  http://127.0.0.1:8099/
       dial tcp 127.0.0.1:8099: connectex: No connection could be made because the target machine actively refused it.
http://127.0.0.1:8080/blog/post-1.html
  404  http://127.0.0.1:8080/blog/archive/2019.html
http://127.0.0.1:8080/blog/post-2.html
  404  http://127.0.0.1:8080/blog/drafts/
  ERR  https://127.0.0.1:8081/ok.html
       http: server gave HTTP response to HTTPS client
http://127.0.0.1:8080/old-page
  404  http://127.0.0.1:8080/team.html
same content:
  http://127.0.0.1:8080/about-print.html
  http://127.0.0.1:8080/about.html
17 links checked, 8 broken, 0 excluded
```

The other formats carry the same results:

| Format | Shape | For |
|---|---|---|
| `text` | Broken links by page, duplicates, summary | People at a terminal |
| `json` | One object: run ID, start time, counts, every result with status, outcome, error, duration and SHA-256, duplicate groups | Scripts and other tools |
| `csv` | One row per URL: url, parent, depth, status, outcome, error, duration | Spreadsheets |
| `junit` | JUnit XML: each URL a test case, broken links failures, excluded links skipped | CI systems that show test results |
| `html` | A standalone page with broken links, duplicates and every URL, escaped by `html/template` | Browsers, `-serve`, `-open` |

## Requirements

| Requirement | How to check |
|---|---|
| Each distinct URL is requested at most once per crawl, however many pages link to it and however it is spelled | `go test ./internal/crawl` (the fake fetcher fails the test on a second fetch); `Normalize` is fuzzed for idempotence |
| Links on the start hosts are followed to `-depth`; links to other hosts are checked but not followed | `TestCrawlerMaxDepth`; `-depth 1` reports `10 links checked` on the test site |
| A broken link shows its status or network error and the page it was found on | Run against the test site: 8 broken links, each under its page |
| Many links are checked at once, and the slowest request, not the sum, sets the run time | `-v` shows every link but `/slow` finished within milliseconds |
| Ctrl-C stops at once with a partial report, status 130, and no leaked goroutines | Press Ctrl-C during `/slow`; `TestCrawlerCancelReturnsPartialResults` (synctest) and `TestCancelledCrawlLeaksNoGoroutines` (goroutineleak profile) |
| No host gets more than `-rate` requests, and no request runs longer than `-timeout` | `-v -rate 2/s` shows checks 500 ms apart per host; `TestCrawlerRateLimit` and `TestCrawlerTimeout` assert exact durations in fake time |
| Filters and a config file work, and flags override the file | `-config linkcheck.json` reports `4 excluded`; a typo in the file exits with 2 naming the field |
| All five formats are stable | Golden-file tests in `internal/report` |
| An interrupted crawl with `-state` resumes where it stopped | Ctrl-C, then the same command again: only the pending URLs are fetched and the totals match an uninterrupted run |
| Identical pages are reported | `about.html` and `about-print.html` appear under `same content` |
| The code has no data races | `go test -race ./...` passes |
| `Links` allocates half what the first version did | `benchstat` before and after: 52.43k to 26.79k allocs/op |
| The binary reports its version and commit, and builds for Linux, macOS and Windows from one machine | `linkcheck -version`; `go version -m dist/linkcheck-linux-amd64` |

## Stack

| Piece | Version |
|---|---|
| Go | 1.27 in `go.mod`, toolchain go1.27.1 |
| `golang.org/x/net/html` | v0.59.0 |
| `golang.org/x/sync/errgroup` | v0.23.0 |
| `golang.org/x/time/rate` | v0.16.0 |
| Everything else | The standard library, including `uuid` (new in Go 1.27), `testing/synctest` and `httptest.NewTestServer` (Go 1.27) |

Every output shown in the steps comes from real runs on Windows 11 with Go 1.27.1. Timings, timestamps, run IDs and the wording of operating-system errors differ on your machine; the links, statuses and counts do not.

## Where each part of the route is used

| Part | Used in |
|---|---|
| Tooling | Step 1 (module, `internal`, dependencies, `go:embed`), step 10 (build constraints, cross-compiling, build info, `go vet`, `go fix`) |
| Types | Step 2 (`Set[T]`, defined `Outcome` with `iota`, slices as a queue, maps), step 5 (pointers for optional settings) |
| Interfaces | Step 6 (`Fetcher` and fakes), step 7 (`Reporter` over `io.Writer`, `Compare`) |
| Errors | Step 2 (`LinkError`, `ErrBadStatus`, `errors.AsType`), step 4 (`ErrTimeout`), step 8 (`fs.ErrNotExist`) |
| Generics | Step 2 (`Set[T]`), step 7 (`Filter`, the self-referential `Comparer`, the generic method `BrokenBy`) |
| Iterators | Step 1 (`Descendants`), step 7 (`iter.Seq`, `iter.Seq2`, `slices.SortedFunc`) |
| Concurrency | Step 3 (worker pool, `select`, context, signals, atomics), step 4 (mutex, rate limit, errgroup) |
| Data in the standard library | Steps 5, 7 and 8: `regexp`, `strconv`, JSON, CSV, XML, `html/template`, gzip, SHA-256, hex, `uuid` |
| The system in the standard library | Steps 1, 3, 4, 7 and 10: flags, HTTP client and server, URL parsing, TCP, `slog`, signals, exit codes, `os/exec`, build info |
| Testing | Step 6 (table tests, helpers, fakes, `httptest`, synctest, fuzzing, examples, coverage, race detector), step 7 (golden files) |
| Performance | Step 9 (benchmarks, CPU and heap profiles, escape analysis, GC cost, goroutine leaks), step 10 (PGO) |
