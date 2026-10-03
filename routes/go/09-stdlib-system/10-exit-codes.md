---
title: Exit codes, stdout and stderr
done_when: "Your program puts results on stdout and diagnostics on stderr, returns documented exit codes, and calls os.Exit only from main after every deferred call has run."
---
A command-line program talks to two kinds of reader. People read the terminal; other programs read its streams and its **exit code**. A shell script asks `if mytool; then ...`, a CI job fails the build on a non-zero code, and `mytool | sort` feeds the output to another program. Getting the streams and the code right is what makes a program usable in those settings.

## Two output streams, one exit code

- **stdout** (`os.Stdout`) carries the program's **result**: the data a user may pipe or redirect.
- **stderr** (`os.Stderr`) carries **diagnostics**: progress, warnings, errors, logs ([[slog]]). Both appear on the terminal, but a pipe or a redirect separates them: `tool > out.txt` still shows stderr on screen.
- **The exit code** is a number from 0 to 255 returned to the parent process. **0 means success; anything else means failure.** `main` returning normally exits with 0.

Conventions you can rely on: `1` for a general failure, `2` for a usage error (the flag package uses it, [[flags-args]]), `130` for termination by Ctrl-C when a shell reports it (128 + the signal number). Beyond those, choose codes that mean something to your users and document them, as `grep` does (0 match, 1 no match, 2 error).

## A program with documented exit codes

The rule for a clean program: `main` does nothing but call a `run` function, which returns an error, and turn that error into an exit code.

```go title="good/main.go"
package main

import (
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
)

// Exit codes the program documents.
const (
	exitOK       = 0
	exitFailures = 1 // ran fine, but found broken links
	exitUsage    = 2 // bad flags or arguments
	exitInternal = 3 // could not do the work at all
)

var errBroken = errors.New("broken links found")

type usageError struct{ msg string }

func (e *usageError) Error() string { return e.msg }

// run does all the work and returns an error; it never calls os.Exit,
// so its deferred calls always run.
func run(args []string, stdout, stderr io.Writer) error {
	fs := flag.NewFlagSet("check", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	mode := fs.String("mode", "ok", "ok, broken or crash")
	if err := fs.Parse(args); err != nil {
		return &usageError{err.Error()}
	}
	defer fmt.Fprintln(stderr, "log: run finished") // diagnostics go to stderr

	switch *mode {
	case "ok":
		fmt.Fprintln(stdout, "3 links checked, 0 broken") // the result goes to stdout
		return nil
	case "broken":
		fmt.Fprintln(stdout, "3 links checked, 1 broken")
		return errBroken
	case "crash":
		return fmt.Errorf("open report: %w", os.ErrPermission)
	}
	return &usageError{"unknown mode " + *mode}
}

func main() {
	err := run(os.Args[1:], os.Stdout, os.Stderr)
	var ue *usageError
	switch {
	case err == nil:
		os.Exit(exitOK)
	case errors.Is(err, errBroken):
		os.Exit(exitFailures) // already reported on stdout; no message needed
	case errors.As(err, &ue):
		fmt.Fprintln(os.Stderr, "usage error:", err)
		os.Exit(exitUsage)
	default:
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(exitInternal)
	}
}
```

```bash
go build -o check ./good
./check; echo "exit=$?"
./check -mode=broken; echo "exit=$?"
./check -mode=crash; echo "exit=$?"
./check -mode=weird; echo "exit=$?"
./check -nope; echo "exit=$?"
```

```text
3 links checked, 0 broken
log: run finished
exit=0
3 links checked, 1 broken
log: run finished
exit=1
log: run finished
error: open report: permission denied
exit=3
log: run finished
usage error: unknown mode weird
exit=2
usage error: flag provided but not defined: -nope
exit=2
```

`echo "exit=$?"` prints the code of the previous command in a POSIX shell (in PowerShell it is `$LASTEXITCODE`). Now separate the streams:

```bash
./check -mode=broken 2>/dev/null   # stdout only
./check -mode=crash >/dev/null     # stderr only
```

```text
3 links checked, 1 broken
```

```text
log: run finished
error: open report: permission denied
```

The result survived the redirect of stderr, and the error survived the redirect of stdout. (On Windows `cmd` use `2>NUL`.)

## How it works

**`run` returns, `main` exits.** All the real work, and all the `defer` statements, live in `run`. When `run` returns, its deferred calls have already run (the `log: run finished` line proves it), and only then does `main` call `os.Exit`. `os.Exit` ends the process at once: no deferred function runs, no buffered writer is flushed, no `Shutdown` is called. This is the whole point of the pattern. It also makes `run` testable: a test calls `run` with buffers for `stdout` and `stderr` and checks both, without the process dying ([[test-doubles]]).

**Why the writers are parameters.** `run(args, stdout, stderr)` writes to `io.Writer` values instead of `os.Stdout`, so nothing global is involved. The same code serves the terminal and a test.

**The error decides the code.** `errors.Is` and `errors.As` ([[is-as]]) map the returned error to a code. The sentinel `errBroken` is not a failure of the tool; the tool did its job and found problems, so the message is already on stdout and `main` prints nothing more. Distinguishing "ran and found problems" (1), "you used it wrong" (2) and "could not run" (3) lets a script react differently to each.

## What os.Exit and its relatives skip

The same program written the common wrong way:

```go title="bad/main.go"
package main

import (
	"fmt"
	"os"
)

func main() {
	defer fmt.Println("deferred: flushing and closing")
	fmt.Println("working")
	if len(os.Args) > 1 {
		fmt.Fprintln(os.Stderr, "error: bad input")
		os.Exit(1) // the deferred call above never runs
	}
}
```

```bash
go build -o bad ./bad
./bad; echo "exit=$?"
./bad x; echo "exit=$?"
```

```text
working
deferred: flushing and closing
exit=0
working
error: bad input
exit=1
```

On the failing path, the deferred line never printed. If that defer closed a file, flushed a `bufio.Writer` or removed a temporary file, that work is silently lost ([[defer]]).

| Call | Exit code | Deferred calls run? |
|---|---|---|
| `main` returns | 0 | yes (for `main`'s own defers) |
| `os.Exit(n)` | `n` | no |
| `log.Fatal(...)`, `log.Fatalf` | 1 | no (it prints, then calls `os.Exit(1)`) |
| unrecovered `panic` | 2 | yes, in the panicking goroutine, then the trace prints ([[panic-recover]]) |
| a fatal runtime error (deadlock, concurrent map write) | 2 | no |
| killed by a signal | 128 + signal as reported by a shell | no, unless you handled it ([[signals]]) |

> [!WARNING]
> Putting results and errors on the same stream, and calling `os.Exit` deep inside the program, are the two mistakes. Symptom of the first: `tool | jq` fails with a JSON parse error because a progress line or a warning appeared in the data; `tool > out.csv` has an error message in the file. Fix: only the result on stdout, everything else on stderr. Symptom of the second: a report file ends truncated or a lock file stays behind, because the `os.Exit` in a helper skipped the deferred `Close`. Fix: return errors upward and exit only in `main`. `log.Fatal` is acceptable in a throwaway script, not in a program with cleanup.

> [!NOTE]
> A usage error is the caller's fault and an internal error is yours; giving them different codes is cheap and helps scripts. Shells use codes above 125 for failures to run a command and for death by signal, so keep your own codes small. If a command exits non-zero only because `Close` on a written file failed, report that error: it is often the first sign of a full disk.

linkcheck returns exit 1 when it found broken links, so CI can fail on them, and keeps its report on stdout and its progress on stderr; the final shape of `main` is in [[step-10-ship]], and its exit codes are tested in [[step-6-tests]].
