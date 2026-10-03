---
title: Running commands with os/exec
done_when: "You can run an external program, capture its stdout and stderr separately, read its exit code, and stop it with a context deadline."
---
`os/exec` starts other programs from yours. A `*exec.Cmd` describes one run: the program, its arguments, its environment, its working directory and where its input and output go. You build it with `exec.Command`, then run it with `Run`, `Output`, `CombinedOutput`, or `Start` plus `Wait`.

Two properties shape everything. First, there is **no shell**: `exec.Command("ls", "*.go")` passes the literal text `*.go` to `ls`, so wildcards, pipes and `&&` do nothing. The arguments are a list, never one string to be parsed, which also makes injection through an argument impossible. Second, the child is a separate process with its own exit status, so "the program failed" is a normal result you must handle.

The examples run the program itself as the child (`os.Executable()` with a `-child` flag), so they behave the same on Windows, macOS and Linux.

## The common ways to run a command

```go title="run/main.go"
package main

import (
	"bytes"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strings"
)

// The program runs itself as the child, so the example works on any OS.
func child(mode string) {
	switch mode {
	case "hello":
		fmt.Println("hello from child, args:", os.Args[3:])
	case "both":
		fmt.Fprintln(os.Stdout, "to stdout")
		fmt.Fprintln(os.Stderr, "to stderr")
	case "fail":
		fmt.Fprintln(os.Stderr, "something broke")
		os.Exit(3)
	case "upper":
		var s string
		fmt.Scan(&s)
		fmt.Println(strings.ToUpper(s))
	case "env":
		fmt.Println("GREETING =", os.Getenv("GREETING"))
		wd, _ := os.Getwd()
		fmt.Println("dir has go.mod:", fileExists("go.mod"), "wd ends with", lastElem(wd))
	}
}

func fileExists(p string) bool { _, err := os.Stat(p); return err == nil }
func lastElem(p string) string {
	p = strings.ReplaceAll(p, "\\", "/")
	return p[strings.LastIndex(p, "/")+1:]
}

func main() {
	if len(os.Args) > 2 && os.Args[1] == "-child" {
		child(os.Args[2])
		return
	}
	self, err := os.Executable()
	if err != nil {
		panic(err)
	}

	// 1. Output: run, wait, capture stdout.
	out, err := exec.Command(self, "-child", "hello", "a b", "c").Output()
	fmt.Printf("1. %q err=%v\n", out, err)

	// 2. CombinedOutput interleaves stdout and stderr in one buffer.
	out, err = exec.Command(self, "-child", "both").CombinedOutput()
	fmt.Printf("2. %q err=%v\n", out, err)

	// 3. Separate buffers.
	cmd := exec.Command(self, "-child", "both")
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err = cmd.Run()
	fmt.Printf("3. stdout=%q stderr=%q err=%v\n", stdout.String(), stderr.String(), err)

	// 4. A non-zero exit is an *exec.ExitError.
	cmd = exec.Command(self, "-child", "fail")
	out, err = cmd.Output()
	var ee *exec.ExitError
	if errors.As(err, &ee) {
		fmt.Printf("4. exit code %d, stderr %q, stdout %q, err: %v\n", ee.ExitCode(), ee.Stderr, out, err)
	}

	// 5. A program that does not exist never starts.
	err = exec.Command("no-such-program-xyz").Run()
	fmt.Printf("5. %v | is ErrNotFound: %t\n", err, errors.Is(err, exec.ErrNotFound))

	// 6. Feed stdin.
	cmd = exec.Command(self, "-child", "upper")
	cmd.Stdin = strings.NewReader("quiet\n")
	out, _ = cmd.Output()
	fmt.Printf("6. %q\n", out)

	// 7. Environment and working directory.
	cmd = exec.Command(self, "-child", "env")
	cmd.Env = append(os.Environ(), "GREETING=hi")
	cmd.Dir = "."
	out, _ = cmd.Output()
	fmt.Printf("7. %s", out)

	// 8. No shell: wildcards and pipes are plain characters.
	out, _ = exec.Command(self, "-child", "hello", "*.go", "|", "wc").Output()
	fmt.Printf("8. %q\n", out)
}
```

```bash
go build -o run ./run
./run
```

```text
1. "hello from child, args: [a b c]\n" err=<nil>
2. "to stdout\nto stderr\n" err=<nil>
3. stdout="to stdout\n" stderr="to stderr\n" err=<nil>
4. exit code 3, stderr "something broke\n", stdout "", err: exit status 3
5. exec: "no-such-program-xyz": executable file not found in %PATH% | is ErrNotFound: true
6. "QUIET\n"
7. GREETING = hi
dir has go.mod: true wd ends with exec
8. "hello from child, args: [*.go | wc]\n"
```

Line 5 is Windows wording (`%PATH%`); on Linux it says `$PATH`. Line 7 shows `go.mod` because the run happened in the module folder.

## How it works

| Method | Does | Use when |
|---|---|---|
| `Run()` | starts, waits, returns the error | you only care that it succeeded |
| `Output()` | `Run` and returns stdout; stderr goes to `ExitError.Stderr` if you did not set `Stderr` | you want the result text |
| `CombinedOutput()` | `Run` with stdout and stderr in one buffer | showing a failing tool's whole output |
| `Start()` then `Wait()` | starts, returns at once; `Wait` collects it | the child outlives a step, or you read its pipes while it runs |

**Standard streams.** `cmd.Stdin`, `cmd.Stdout` and `cmd.Stderr` are `io.Reader` and `io.Writer` values ([[io-composition]]). Left `nil`, they connect to the null device: the child reads nothing and its output is discarded. Set `cmd.Stdout = os.Stdout` to let the child write straight to your terminal. When the writer is not an `*os.File`, such as a `bytes.Buffer`, `exec` creates a pipe and a goroutine to copy into it; `Wait` returns only when the copying is done. Setting `Stdout` and `Stderr` to the same value makes one pipe for both.

**Exit status versus failure to start.** There are two different errors:

- the program could not be started at all: not found (`exec.ErrNotFound`, tested with `errors.Is`), not executable, bad directory. `Run` returns that error, and no process ever ran.
- the program ran and exited non-zero: `*exec.ExitError`, found with `errors.As` ([[is-as]]). `ee.ExitCode()` is the status; `ee.Stderr` holds the tail of the child's stderr when you called `Output` without setting `Stderr`. Its text is `exit status 3`.

An exit code is the child's only structured answer, so tools document theirs: `grep` exits 1 for "no match", which is not a failure. Check the code instead of treating every `ExitError` as an error.

**Environment and directory.** `cmd.Env == nil` means the child inherits your environment. A non-nil slice of `KEY=value` strings replaces it entirely, which is why line 7 starts from `os.Environ()`. `cmd.Dir` sets the working directory; empty means yours. A bare program name such as `go` is searched for on `PATH` with `exec.LookPath`. Since Go 1.19, a name found only in the current directory is not run and `Run` returns an error wrapping `exec.ErrDot`; this stops a downloaded repository from supplying its own `ls`. Give the path explicitly (`./tool`) when you mean it.

**No shell, so build argument lists.** Line 8 passed `*.go | wc` as plain arguments. If you really need shell features, run the shell: `exec.Command("sh", "-c", script)`. Then you are responsible for quoting, and any user input in `script` is an injection risk. Almost always the right choice is to run the program directly and do the glob or pipe in Go.

## Stopping a command: CommandContext and WaitDelay

A child can hang. `exec.CommandContext(ctx, ...)` kills it when `ctx` is done:

```go title="ctx/main.go"
package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"time"
)

func main() {
	if len(os.Args) > 1 && os.Args[1] == "-child" {
		time.Sleep(10 * time.Second)
		return
	}
	self, _ := os.Executable()

	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancel()

	cmd := exec.CommandContext(ctx, self, "-child")
	cmd.WaitDelay = time.Second // after cancel, wait at most 1s for I/O to finish
	start := time.Now()
	err := cmd.Run()
	fmt.Println("elapsed ~", time.Since(start).Round(100*time.Millisecond))
	fmt.Println("err:", err)
	fmt.Println("deadline exceeded:", errors.Is(ctx.Err(), context.DeadlineExceeded))
	fmt.Println("process state:", cmd.ProcessState)
}
```

```bash
go build -o ctx ./ctx
./ctx
```

```text
elapsed ~ 300ms
err: exit status 1
deadline exceeded: true
process state: exit status 1
```

The child sleeps 10 seconds; the context fires after 300 ms; `exec` kills the process and `Run` returns. The error is the kill's exit status (`exit status 1` on Windows, `signal: killed` on Linux and macOS), not `context.DeadlineExceeded`, so ask `ctx.Err()` why it stopped ([[context]]).

By default the cancel action is `Process.Kill`, which cannot be caught, so the child gets no chance to clean up. Set `cmd.Cancel` to a function that does something gentler, such as sending `os.Interrupt` (on Linux and macOS; Windows cannot send it to another process) and, with `cmd.WaitDelay`, a limit on how long to wait before killing it anyway. `WaitDelay` also fixes a subtler hang: if a child starts its own grandchildren that keep your pipe open, `Wait` would block until they exit; after `WaitDelay` it closes the pipes and returns `exec.ErrWaitDelay`.

## Opening the report: Start without Wait

linkcheck's `--open` flag asks the operating system to open a file in the default program. The viewer is not ours to wait for, so this uses `Start`:

```go title="open/main.go"
package main

import (
	"fmt"
	"os"
	"os/exec"
	"runtime"
)

// open asks the operating system to open a file or URL with its default program.
func open(target string) error {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "windows":
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", target)
	case "darwin":
		cmd = exec.Command("open", target)
	default:
		cmd = exec.Command("xdg-open", target)
	}
	return cmd.Start() // do not wait: the viewer outlives us
}

func main() {
	if len(os.Args) != 2 {
		fmt.Fprintln(os.Stderr, "usage: open <file-or-url>")
		os.Exit(2)
	}
	if err := open(os.Args[1]); err != nil {
		fmt.Fprintln(os.Stderr, "open:", err)
		os.Exit(1)
	}
}
```

```bash
go run ./open report.html
```

The command for "open this file" is different on every platform, which is what `runtime.GOOS` selects (the compiler constant is covered in [[build-tags]]). `Start` returns once the process exists. The program does not call `Wait`, so on Unix the finished child stays a zombie entry until your program exits; for a CLI that exits right away this does not matter, and a long-running program should call `go cmd.Wait()`.

> [!WARNING]
> Building a shell string from input (`exec.Command("sh", "-c", "grep "+userInput+" file")`) is command injection: an input like `x; rm -rf ~` runs. Symptom: arbitrary commands execute with your program's rights. Fix: pass arguments separately (`exec.Command("grep", "--", userInput, "file")`) and never go through `sh -c` with user data. Another common mistake is reading `cmd.Stdout` buffers before `Wait`/`Run` returns, which races with the copying goroutine; read them only after the command has finished.

> [!NOTE]
> `cmd.Output()` and `Run()` return errors without the child's stderr text unless you capture it. For a helpful message, set `cmd.Stderr` to a `bytes.Buffer` and include its contents when the exit is non-zero, as the third example does.

linkcheck opens its finished report with this `open` function in [[step-10-ship]].
