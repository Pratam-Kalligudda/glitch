---
title: Files and the os package
done_when: "You read and write a file both in one call and in pieces, close it and check the error, and replace a file atomically with a temporary file and a rename."
---
The `os` package is Go's portable interface to the operating system: files and directories,
environment variables, the working directory, process exit. This stop covers files. The
central type is `*os.File`, a handle to an open file that implements `io.Reader`,
`io.Writer`, `io.Closer` and `io.Seeker`, so everything from [[io-composition]] works on it.

Every example here creates its own temporary directory with `os.MkdirTemp` and deletes it
with `defer os.RemoveAll(dir)`, so you can run them without leaving files behind.

## Whole files in one call

```go title="a/main.go"
package main

import (
	"errors"
	"fmt"
	"io/fs"
	"log"
	"os"
	"path/filepath"
)

func main() {
	dir, err := os.MkdirTemp("", "files-demo-*")
	if err != nil {
		log.Fatal(err)
	}
	defer os.RemoveAll(dir)
	path := filepath.Join(dir, "notes.txt")

	// Whole-file helpers: fine for small files.
	if err := os.WriteFile(path, []byte("line one\nline two\n"), 0o644); err != nil {
		log.Fatal(err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		log.Fatal(err)
	}
	fmt.Printf("%q\n", data)

	// WriteFile truncates an existing file.
	os.WriteFile(path, []byte("short"), 0o644)
	data, _ = os.ReadFile(path)
	fmt.Printf("%q\n", data)

	// Missing file: test with errors.Is, not by comparing error text.
	_, err = os.ReadFile(filepath.Join(dir, "missing.txt"))
	fmt.Println(errors.Is(err, fs.ErrNotExist))
	var pe *fs.PathError
	if errors.As(err, &pe) {
		fmt.Println(pe.Op, filepath.Base(pe.Path))
	}

	// Stat.
	info, err := os.Stat(path)
	if err != nil {
		log.Fatal(err)
	}
	fmt.Println(info.Name(), info.Size(), info.IsDir(), info.Mode().IsRegular())
}
```

```bash
go run ./a
```

```text
"line one\nline two\n"
"short"
true
open missing.txt
notes.txt 5 false true
```

`os.ReadFile(path)` opens, reads everything, closes and returns the bytes. `os.WriteFile(path,
data, perm)` creates the file (or **truncates** an existing one), writes and closes. These are
the right tools for small files such as configs and state: no handle to leak, no loop to write.
Their cost is that the whole content sits in memory, so for large or unbounded files use a
`*os.File` and stream ([[bufio]]).

**The permission argument** (`0o644`) is a Unix mode: owner read and write, everyone else read
only. It applies only when the file is created, is reduced by the process `umask`, and on
Windows only the read-only bit has any effect. The `0o` prefix is Go's octal notation.

**Errors are `*fs.PathError`.** The error carries the operation (`open`), the path and the
cause. To ask *why*, use `errors.Is(err, fs.ErrNotExist)` (or `fs.ErrExist`, `fs.ErrPermission`):
it works the same on every operating system, whereas the message text does not (`no such file
or directory` on Linux, `The system cannot find the file specified.` on Windows). The older
`os.IsNotExist(err)` does not see through wrapped errors ([[is-as]]), so prefer `errors.Is`.

`os.Stat(path)` returns an `fs.FileInfo`: `Name()`, `Size()`, `Mode()`, `ModTime()`, `IsDir()`.
`os.Lstat` does not follow a symbolic link. To check whether a file exists, call `Stat` and test
the error with `errors.Is(err, fs.ErrNotExist)`.

## Opening, reading, writing, closing

```go title="b/main.go"
package main

import (
	"bufio"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
)

func main() {
	dir, err := os.MkdirTemp("", "files-demo-*")
	if err != nil {
		log.Fatal(err)
	}
	defer os.RemoveAll(dir)
	path := filepath.Join(dir, "log.txt")

	// Create: read-write, truncates or creates, mode 0o666 before umask.
	f, err := os.Create(path)
	if err != nil {
		log.Fatal(err)
	}
	fmt.Fprintln(f, "first")
	if err := f.Close(); err != nil { // Close can report a failed write
		log.Fatal(err)
	}

	// OpenFile with flags: append.
	f, err = os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		log.Fatal(err)
	}
	fmt.Fprintln(f, "second")
	f.Close()

	// Open: read-only. Read in pieces, seek back.
	f, err = os.Open(path)
	if err != nil {
		log.Fatal(err)
	}
	defer f.Close()
	buf := make([]byte, 4)
	n, _ := f.Read(buf)
	fmt.Printf("%d %q\n", n, buf[:n])
	pos, _ := f.Seek(0, io.SeekStart)
	fmt.Println("seek to", pos)
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		fmt.Println("line:", sc.Text())
	}

	// O_EXCL: create only if it does not exist.
	_, err = os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o644)
	fmt.Println(os.IsExist(err), err != nil)
}
```

```text
4 "firs"
seek to 0
line: first
line: second
true true
```

| Function | Opens for | If the file exists | If it does not exist |
|---|---|---|---|
| `os.Open(name)` | reading | opens it | error |
| `os.Create(name)` | reading and writing | **truncates** it | creates it (mode `0o666` before umask) |
| `os.OpenFile(name, flag, perm)` | whatever `flag` says | per flag | per flag |

`OpenFile` takes the combination you build from flags joined with `|`:

| Flag | Meaning |
|---|---|
| `os.O_RDONLY`, `os.O_WRONLY`, `os.O_RDWR` | Access mode (choose exactly one) |
| `os.O_APPEND` | Every write goes to the end |
| `os.O_CREATE` | Create the file if it is missing |
| `os.O_TRUNC` | Truncate an existing file to zero length |
| `os.O_EXCL` | With `O_CREATE`: fail if the file already exists. Makes "create only if new" atomic |
| `os.O_SYNC` | Writes reach the disk before returning |

Reading in pieces: `f.Read(buf)` fills up to `len(buf)` bytes and returns how many it
filled. `f.Seek(offset, whence)` moves the position (`io.SeekStart`, `io.SeekCurrent`,
`io.SeekEnd`); `f.ReadAt` and `f.WriteAt` read and write at an offset without moving the
position. For lines, wrap the file in a `bufio.Scanner`.

**Close the file, and check the error for files you wrote.** `defer f.Close()` is right for a
file you only read. For a file you wrote, the data may still sit in an operating-system buffer,
and a failure (disk full, network file system) can show up only at `Close`. Check that error,
and call `f.Sync()` first if the data must survive a power cut.

> [!WARNING]
> Opening files in a loop with `defer f.Close()` inside the loop body keeps every file open
> until the function returns. Symptom: `too many open files` after a few thousand iterations.
> Fix: move the loop body into a function so each call closes its own file, or call `Close`
> explicitly at the end of each iteration.

## Directories

```go title="c/main.go"
package main

import (
	"fmt"
	"log"
	"os"
	"path/filepath"
)

func main() {
	dir, err := os.MkdirTemp("", "files-demo-*")
	if err != nil {
		log.Fatal(err)
	}
	defer os.RemoveAll(dir)

	nested := filepath.Join(dir, "a", "b", "c")
	fmt.Println(os.Mkdir(nested, 0o755) != nil) // fails: parents missing
	fmt.Println(os.MkdirAll(nested, 0o755))     // creates all, no error if present
	fmt.Println(os.MkdirAll(nested, 0o755))

	os.WriteFile(filepath.Join(dir, "a", "x.txt"), []byte("x"), 0o644)
	os.WriteFile(filepath.Join(dir, "a", "y.txt"), []byte("yy"), 0o644)

	entries, err := os.ReadDir(filepath.Join(dir, "a")) // sorted by name
	if err != nil {
		log.Fatal(err)
	}
	for _, e := range entries {
		info, _ := e.Info()
		fmt.Println(e.Name(), e.IsDir(), info.Size())
	}

	err = os.Rename(filepath.Join(dir, "a", "x.txt"), filepath.Join(dir, "a", "z.txt"))
	fmt.Println("rename:", err)
	fmt.Println("remove non-empty dir:", os.Remove(filepath.Join(dir, "a")) != nil)
	fmt.Println("remove all:", os.RemoveAll(filepath.Join(dir, "a")))
	_, err = os.Stat(filepath.Join(dir, "a"))
	fmt.Println(os.IsNotExist(err))
}
```

```text
true
<nil>
<nil>
b true 0
x.txt false 1
y.txt false 2
rename: <nil>
remove non-empty dir: true
remove all: <nil>
true
```

- `os.Mkdir` makes one directory and fails when the parent is missing. `os.MkdirAll` makes the
  whole path and is not an error when it already exists.
- `os.ReadDir(dir)` returns `[]fs.DirEntry` **sorted by file name**. A `DirEntry` knows its name
  and whether it is a directory without a system call; `e.Info()` fetches the size and time.
- `os.Rename(old, new)` renames or moves within one file system and replaces an existing
  file at `new`. Across disks or volumes it fails: copy and delete instead.
- `os.Remove` deletes a file or an **empty** directory. `os.RemoveAll` deletes a whole tree
  and returns `nil` when the path is already gone. Check what you pass to it.

Paths are built with `path/filepath`, which uses the separator of the current operating system
([[filepath-fs]]). Do not join them with `+ "/" +`.

## Replacing a file atomically

If a program crashes while `WriteFile` is half done, the file is left truncated or partial.
For state that must never be corrupt, write a new file next to the old one and rename it over
the target: a rename is atomic on one file system, so readers see the whole old file or the whole
new one.

```go title="d/main.go"
package main

import (
	"fmt"
	"log"
	"os"
	"path/filepath"
)

// writeFileAtomic writes data to a temporary file in the same directory,
// then renames it over the target, so readers see the old or the new
// content and never a half-written file.
func writeFileAtomic(path string, data []byte, perm os.FileMode) (err error) {
	tmp, err := os.CreateTemp(filepath.Dir(path), filepath.Base(path)+".tmp-*")
	if err != nil {
		return err
	}
	defer func() {
		if err != nil {
			tmp.Close()
			os.Remove(tmp.Name())
		}
	}()
	if _, err = tmp.Write(data); err != nil {
		return err
	}
	if err = tmp.Sync(); err != nil { // flush to disk before the rename
		return err
	}
	if err = tmp.Close(); err != nil {
		return err
	}
	if err = os.Chmod(tmp.Name(), perm); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), path)
}

func main() {
	dir, err := os.MkdirTemp("", "atomic-*")
	if err != nil {
		log.Fatal(err)
	}
	defer os.RemoveAll(dir)

	path := filepath.Join(dir, "state.json")
	for _, content := range []string{`{"v":1}`, `{"v":2}`} {
		if err := writeFileAtomic(path, []byte(content), 0o644); err != nil {
			log.Fatal(err)
		}
	}
	data, _ := os.ReadFile(path)
	fmt.Println(string(data))

	entries, _ := os.ReadDir(dir)
	for _, e := range entries {
		fmt.Println("left in dir:", e.Name())
	}
}
```

```text
{"v":2}
left in dir: state.json
```

How it works: `os.CreateTemp(dir, pattern)` creates a uniquely named file (the `*` in the
pattern is replaced by random digits; without a `*` they are appended) in the **same
directory**, which guarantees the same file system. The function writes, calls `Sync` so the
bytes are on disk, closes, sets the mode and renames. The deferred function removes the
temporary file if anything failed. linkcheck saves its crawl state with the same temporary-file-and-rename idea in
[[step-8-state]].

## Environment, arguments and exit

```go title="e/main.go"
package main

import (
	"fmt"
	"os"
)

func main() {
	fmt.Println(len(os.Args) >= 1)

	os.Setenv("LINKCHECK_DEPTH", "3")
	fmt.Println(os.Getenv("LINKCHECK_DEPTH"))
	v, ok := os.LookupEnv("LINKCHECK_UNSET")
	fmt.Printf("%q %v\n", v, ok)
	os.Setenv("LINKCHECK_EMPTY", "")
	v, ok = os.LookupEnv("LINKCHECK_EMPTY")
	fmt.Printf("%q %v\n", v, ok)
	fmt.Println(os.ExpandEnv("depth=$LINKCHECK_DEPTH ${LINKCHECK_UNSET}end"))
	fmt.Println(os.Expand("hi $name", func(k string) string { return "<" + k + ">" }))

	home, err := os.UserHomeDir()
	fmt.Println(home != "", err)
	wd, err := os.Getwd()
	fmt.Println(wd != "", err)
	host, err := os.Hostname()
	fmt.Println(host != "", err)

	defer fmt.Println("deferred: never printed")
	os.Exit(3)
}
```

```bash
go build -o envdemo ./e
./envdemo; echo $?
```

```text
true
3
"" false
"" true
depth=3 end
hi <name>
true <nil>
true <nil>
true <nil>
exit status 3
```

(The output above is from `go run`, which prints `exit status 3` and exits 1 itself. The built
binary exits with the real code, `3`.)

- `os.Args` is the command line: `os.Args[0]` is the program and the rest are arguments. Use the
  `flag` package for anything beyond a few arguments ([[flags-args]]).
- `os.Getenv(k)` returns `""` for an unset variable, and also for one set to the empty string.
  `os.LookupEnv(k)` returns the value and whether it is set, so use it when the difference
  matters. `os.Setenv`, `os.Unsetenv` and `os.Environ()` change and list the process's
  environment. `os.ExpandEnv` and `os.Expand` substitute `$VAR` and `${VAR}` in a string.
- `os.UserHomeDir`, `os.UserConfigDir`, `os.UserCacheDir`, `os.TempDir`, `os.Getwd` and
  `os.Hostname` ask the operating system for standard places.
- `os.Exit(code)` ends the process immediately: **deferred functions do not run**, as the
  output shows (the `deferred: never printed` line is missing). Return from `main` or run your
  cleanup first. [[exit-codes]] covers exit codes.

## Confining access to one directory

A path that comes from a user (`../../etc/passwd`) can escape the directory you meant to serve.
Checking the string for `..` is error-prone because symbolic links also leave a directory.
`os.OpenRoot(dir)` (Go 1.24) returns an `*os.Root` whose methods refuse any name that resolves
outside that directory, symbolic links included:

```go title="f/main.go"
package main

import (
	"fmt"
	"log"
	"os"
	"path/filepath"
)

func main() {
	base, err := os.MkdirTemp("", "root-demo-*")
	if err != nil {
		log.Fatal(err)
	}
	defer os.RemoveAll(base)

	uploads := filepath.Join(base, "uploads")
	os.Mkdir(uploads, 0o755)
	os.WriteFile(filepath.Join(base, "secret.txt"), []byte("top secret"), 0o644)
	os.WriteFile(filepath.Join(uploads, "ok.txt"), []byte("public"), 0o644)

	root, err := os.OpenRoot(uploads)
	if err != nil {
		log.Fatal(err)
	}
	defer root.Close()

	b, err := root.ReadFile("ok.txt")
	fmt.Printf("%s %v\n", b, err)

	_, err = root.ReadFile("../secret.txt")
	fmt.Println(err != nil)
	fmt.Println(err)
	_, err = root.Open("a/../../secret.txt")
	fmt.Println(err != nil)

	// Without Root the same path escapes.
	b, err = os.ReadFile(filepath.Join(uploads, "../secret.txt"))
	fmt.Printf("%s %v\n", b, err)
}
```

```text
public <nil>
true
openat ../secret.txt: path escapes from parent
true
top secret <nil>
```

`Root` has the usual methods (`Open`, `Create`, `OpenFile`, `ReadFile`, `Mkdir`, `Remove`, `Stat`,
`FS()` and more). `os.OpenInRoot(dir, name)` opens one file that way. Use it wherever a file
name comes from a request, an archive entry or any other input you do not control.

> [!NOTE]
> `Root` allows symbolic links that stay inside the directory, and it does not stop access to
> Unix device files or other mounted file systems under the root. See `go doc os.Root` for the
> per-platform details.

linkcheck opens its config file with `os.Open` in [[step-5-filters]] and writes its report
to a file you choose in [[step-7-reporters]].
