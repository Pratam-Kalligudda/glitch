---
title: Flags and subcommands
done_when: "A program with two subcommands parses its own flags, reports a bad value with exit code 2, and prints usage for -h."
---
A command-line program receives its inputs as a slice of strings, `os.Args`. `os.Args[0]` is the program's name and the rest are the arguments exactly as the shell split them. The `flag` package turns that slice into typed values: it parses `-timeout=5s` into a `time.Duration`, rejects a bad value with a message, and generates the usage text.

## Declaring and parsing flags

```go title="main.go"
package main

import (
	"flag"
	"fmt"
	"os"
	"time"
)

func main() {
	var (
		timeout = flag.Duration("timeout", 10*time.Second, "request timeout")
		depth   = flag.Int("depth", 2, "maximum crawl depth")
		verbose = flag.Bool("v", false, "verbose output")
	)
	var name string
	flag.StringVar(&name, "name", "world", "who to greet")
	flag.Parse()

	fmt.Println("timeout:", *timeout)
	fmt.Println("depth:", *depth)
	fmt.Println("verbose:", *verbose)
	fmt.Println("name:", name)
	fmt.Println("args:", flag.Args(), "count:", flag.NArg())
	if flag.NArg() == 0 {
		fmt.Fprintln(os.Stderr, "no arguments given")
	}
}
```

Each declaration comes in two forms. `flag.Int("depth", 2, "usage")` returns a `*int` that points at the parsed value. `flag.IntVar(&n, "depth", 2, "usage")` stores into a variable you already have. Both set the default, which is the value when the flag is absent. Nothing is parsed until `flag.Parse()` reads `os.Args[1:]`; read the values only after it.

```bash
go build -o flags .
./flags
./flags -timeout=1m30s --depth 5 -v -name Ada site.com extra -v
./flags -v=false -- -depth 9
```

```text
timeout: 10s
depth: 2
verbose: false
name: world
args: [] count: 0
no arguments given
timeout: 1m30s
depth: 5
verbose: true
name: Ada
args: [site.com extra -v] count: 3
timeout: 10s
depth: 2
verbose: false
name: world
args: [-depth 9] count: 2
```

## The parsing rules

- **One dash or two.** `-depth` and `--depth` are the same. The value follows after `=` or a space: `-depth=5`, `-depth 5`.
- **Booleans take no separate value.** `-v` means true. To set false you must write `-v=false`: `-v false` makes `false` a positional argument, because the parser cannot know whether `false` was meant for the flag.
- **Parsing stops at the first non-flag.** In the second run, `site.com` ended flag parsing, so the later `-v` became a plain argument. Flags go before positional arguments.
- **`--` ends flag parsing explicitly.** The third run passed `-depth 9` through as two arguments, which is how you hand arguments to another program.
- **Types are checked.** `Duration` accepts `90s`, `1m30s` and `250ms`, the same syntax as `time.ParseDuration` ([[time-pkg]]).

## Errors, usage and exit codes

`flag.Parse` uses the `flag.CommandLine` flag set, which is created with `ExitOnError`. A bad flag prints the problem and the usage text to stderr, then exits:

```bash
./flags -depth abc
echo "exit=$?"
./flags -help
echo "exit=$?"
```

```text
invalid value "abc" for flag -depth: parse error
Usage of ./flags:
  -depth int
    	maximum crawl depth (default 2)
  -name string
    	who to greet (default "world")
  -timeout duration
    	request timeout (default 10s)
  -v	verbose output
exit=2
Usage of ./flags:
  -depth int
    	maximum crawl depth (default 2)
  -name string
    	who to greet (default "world")
  -timeout duration
    	request timeout (default 10s)
  -v	verbose output
exit=0
```

Exit code 2 means a usage error, by Unix convention; asking for help with `-h` or `-help` exits 0 ([[exit-codes]] covers exit codes in full). The usage line shows the path the program was started with, so it differs on your machine.

## Subcommands with FlagSet

`git commit` and `go build` are subcommands: the first argument picks a command, and each command has its own flags. The package-level `flag.Int` functions work on one global flag set, so give each subcommand its own `flag.FlagSet`. Write the program as a `run` function that takes arguments and writers, so a test can call it without touching `os.Args` or the real terminal ([[test-doubles]] shows why):

```go title="sub/main.go"
package main

import (
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"strings"
)

// listFlag collects every occurrence of a repeated flag: -tag a -tag b.
type listFlag []string

func (l *listFlag) String() string { return strings.Join(*l, ",") }

func (l *listFlag) Set(v string) error {
	if v == "" {
		return errors.New("empty value")
	}
	*l = append(*l, v)
	return nil
}

func run(args []string, stdout, stderr io.Writer) error {
	if len(args) == 0 {
		return errors.New("usage: tool <check|serve> [flags]")
	}
	switch args[0] {
	case "check":
		fs := flag.NewFlagSet("check", flag.ContinueOnError)
		fs.SetOutput(stderr)
		var tags listFlag
		depth := fs.Int("depth", 2, "maximum crawl depth")
		fs.Var(&tags, "tag", "label to attach (repeatable)")
		fs.Func("level", "log level: debug or info", func(s string) error {
			if s != "debug" && s != "info" {
				return fmt.Errorf("unknown level %q", s)
			}
			return nil
		})
		if err := fs.Parse(args[1:]); err != nil {
			return err
		}
		fmt.Fprintf(stdout, "check depth=%d tags=%v urls=%v\n", *depth, []string(tags), fs.Args())
		return nil
	case "serve":
		fs := flag.NewFlagSet("serve", flag.ContinueOnError)
		fs.SetOutput(stderr)
		addr := fs.String("addr", ":8080", "listen address")
		if err := fs.Parse(args[1:]); err != nil {
			return err
		}
		fmt.Fprintln(stdout, "serve on", *addr)
		return nil
	default:
		return fmt.Errorf("unknown command %q", args[0])
	}
}

func main() {
	if err := run(os.Args[1:], os.Stdout, os.Stderr); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return
		}
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(2)
	}
}
```

```bash
go build -o tool ./sub
./tool check -depth 3 -tag a -tag b https://x.test
./tool serve -addr :9000
./tool serve -h
./tool check -level loud
./tool deploy
```

```text
check depth=3 tags=[a b] urls=[https://x.test]
serve on :9000
Usage of serve:
  -addr string
    	listen address (default ":8080")
invalid value "loud" for flag -level: unknown level "loud"
Usage of check:
  -depth int
    	maximum crawl depth (default 2)
  -level value
    	log level: debug or info
  -tag value
    	label to attach (repeatable)
error: invalid value "loud" for flag -level: unknown level "loud"
error: unknown command "deploy"
```

## How it works

A `FlagSet` has an error policy chosen at creation. `flag.ContinueOnError` makes `Parse` return the error instead of exiting, so `run` can return it and `main` alone decides the exit code. `ExitOnError` (the global set's policy) calls `os.Exit(2)` inside `Parse`; `PanicOnError` panics. With `-h`, `Parse` prints usage and returns `flag.ErrHelp`, and `main` treats that as success.

With `ContinueOnError` the flag set prints the "invalid value" line and usage itself, and then `main` prints its own `error:` line, so a bad flag is reported twice, as the output above shows. Either set the flag set's output to `io.Discard` and print only in `main`, or let the flag set print and have `main` only choose the exit code.

`fs.SetOutput(stderr)` sends the usage text and the "invalid value" message to the writer you pass. The default is stderr already; setting it explicitly lets a test capture it.

**Custom flag types** implement the two-method `flag.Value` interface: `String() string` and `Set(string) error`. `Set` runs once per occurrence, so appending to a slice gives a repeatable flag, as `-tag a -tag b` shows. An error from `Set` becomes the "invalid value" message. For a one-off parser, `fs.Func(name, usage, func(string) error)` is shorter than a type. The usage text prints a custom flag's type as `value`.

After `Parse`, `fs.Args()` returns the arguments left over and `fs.NArg()` their count. `fs.Visit` calls a function for each flag that was actually set, which is how you tell "the user passed `-depth 2`" from "the default was 2".

> [!WARNING]
> Reading a flag before `Parse`, or forgetting `Parse`, silently gives you the defaults. Symptom: `-depth 5` seems to be ignored. Fix: call `flag.Parse()` (or `fs.Parse(args)`) first, then dereference. A second trap: putting a flag after a positional argument (`tool site.com -v`) treats `-v` as an argument. Fix: tell users flags come first, or reorder `fs.Args()` yourself.

> [!NOTE]
> The standard `flag` package has no short and long aliases, no required flags and no environment fallback. You add those by hand: check `fs.NArg()` or set a sentinel default, and read `os.Getenv` before `Parse` to pick the default. Larger tools often use a third-party package; for most programs the standard one is enough.

linkcheck declares its flags with the `flag` package and custom flag types in [[step-4-polite]], and adds its `--exclude` and `--include` flags in [[step-5-filters]].
