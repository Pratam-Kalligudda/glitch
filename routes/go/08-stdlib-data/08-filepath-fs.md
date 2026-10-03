---
title: Paths, io/fs and walking directories
---
File names are strings with rules, and the rules differ by operating system: Unix uses `/`,
Windows uses `\` and drive letters such as `C:`. Go gives you two path packages and one
abstraction for "a tree of files":

- **`path/filepath`** manipulates file system paths using the separator of the OS the program
  runs on.
- **`path`** manipulates slash-separated paths on every OS: URL paths, archive entry names, paths
  inside `io/fs` file systems.
- **`io/fs`** defines `fs.FS`, a read-only file system interface, so code can read a real
  directory, an embedded one ([[embed]]), a zip file or an in-memory test tree the same way.

## filepath versus path

```go title="a/main.go"
package main

import (
	"fmt"
	"path"
	"path/filepath"
	"runtime"
)

func main() {
	fmt.Println(runtime.GOOS, string(filepath.Separator), string(filepath.ListSeparator))

	// filepath uses the OS separator; path always uses "/".
	fmt.Println(filepath.Join("a", "b", "..", "c", "file.txt"))
	fmt.Println(path.Join("a", "b", "..", "c", "file.txt"))
	fmt.Println(filepath.Join("a", "", "b"), filepath.Join())

	p := "/srv/site/docs/index.tar.gz"
	fmt.Println(filepath.Dir(p), filepath.Base(p), filepath.Ext(p))
	fmt.Println(filepath.Clean("a//b/./c/../d/"))
	fmt.Println(filepath.ToSlash(filepath.Join("a", "b")), filepath.FromSlash("a/b"))

	dir, file := filepath.Split("a/b/c.txt")
	fmt.Printf("%q %q\n", dir, file)

	rel, err := filepath.Rel("/srv/site", "/srv/site/docs/a.md")
	fmt.Println(filepath.ToSlash(rel), err)
	fmt.Println(filepath.IsAbs("a/b"), filepath.IsLocal("a/b"), filepath.IsLocal("../x"), filepath.IsLocal("/x"))

	m, _ := filepath.Match("*.go", "main.go")
	fmt.Println(m)
	fmt.Println(path.Base("/a/b/"), path.Dir("/a/b/"), path.Ext("x.tar.gz"))
}
```

```bash
go run ./a
```

```text
windows \ ;
a\c\file.txt
a/c/file.txt
a\b 
\srv\site\docs index.tar.gz .gz
a\b\d
a/b a\b
"a/b/" "c.txt"
docs/a.md <nil>
false true false false
true
b /a/b .gz
```

The output above is from Windows. On Linux or macOS the first line is `linux / :` (or
`darwin / :`) and every path prints with `/`: `a/c/file.txt`, `/srv/site/docs` and so on.
The point is that the `filepath.Join` line follows the OS and the `path.Join` line does not.

| Function | What it does |
|---|---|
| `Join(elems...)` | Joins with the OS separator and cleans the result; empty elements are ignored |
| `Clean(p)` | Lexical simplification: removes `//`, `.` and resolves `..` without touching the disk |
| `Dir(p)`, `Base(p)`, `Ext(p)` | Directory part, last element, extension (including the dot, only the last one: `.gz`) |
| `Split(p)` | Directory (with trailing separator) and file |
| `Rel(base, target)` | Relative path from `base` to `target`; error if there is none |
| `Abs(p)` | Absolute path, using the working directory |
| `IsAbs(p)`, `IsLocal(p)` | Is it absolute? Does it stay inside the current directory (no `..`, not absolute, no reserved names)? |
| `ToSlash`, `FromSlash` | Convert separators to and from `/`, so output is the same on every OS |
| `Match(pattern, name)`, `Glob(pattern)` | Shell-style patterns (`*`, `?`, `[a-z]`); `*` does not cross a separator |
| `VolumeName(p)` | `C:` on Windows, empty on Unix |
| `EvalSymlinks(p)` | Resolve symbolic links |

All the cleaning is **lexical**: `Clean("a/../b")` is `b` even if `a` is a symbolic link to
somewhere else. Treat it as string work, not a check against the disk.

`Join` is the only correct way to build a path. Concatenating with `"/"` produces paths that
work on your laptop and fail on a Windows build, and concatenating a user value does not clean
`..`.

```go title="b/main.go"
package main

import (
	"fmt"
	"path"
	"path/filepath"
)

func main() {
	// A URL path is not a file path: always use package path for it.
	fmt.Println(path.Join("/api", "v1", "users"))
	fmt.Println(filepath.Join("/api", "v1", "users"))
	fmt.Println(filepath.Clean(`C:\a\..\b`))
	fmt.Println(filepath.VolumeName(`C:\a\b`))
}
```

```text
/api/v1/users
\api\v1\users
C:\b
C:
```

(Windows output; on Linux the second line is `/api/v1/users` and the last two lines are
`C:\a\..\b` unchanged and empty, because `\` is an ordinary character there.)

> [!WARNING]
> Using `filepath` for a URL path or `path` for a file path works only on Unix. Symptom: a
> web handler or a link builder that outputs `\api\v1\users` when built for Windows, or a file
> tool that cannot open `C:\...` paths. Fix: URL and archive names always use package `path`
> (and `net/url`, [[url-parsing]]); file names always use `filepath`. Convert at the boundary
> with `filepath.ToSlash` and `filepath.FromSlash`.

> [!WARNING]
> Joining a user-supplied name onto a directory does not make it safe: `filepath.Join("/srv/
> uploads", "../../etc/passwd")` is `/etc/passwd`. Validate with `filepath.IsLocal(name)` first, or
> open files through `os.OpenRoot` ([[os-files]]).

## Walking a directory tree

`filepath.WalkDir(root, fn)` calls `fn` for the root and every file and directory under it, in
**lexical order**. `fn` receives the path, an `fs.DirEntry` (cheap, no `Stat` call) and any error
from reading that entry.

```go title="c/main.go"
package main

import (
	"fmt"
	"io/fs"
	"log"
	"os"
	"path/filepath"
	"strings"
)

func main() {
	dir, err := os.MkdirTemp("", "walk-*")
	if err != nil {
		log.Fatal(err)
	}
	defer os.RemoveAll(dir)
	for _, f := range []string{"README.md", "src/main.go", "src/util.go", "src/internal/x.go", "node_modules/a/b.js", "docs/guide.md"} {
		p := filepath.Join(dir, filepath.FromSlash(f))
		os.MkdirAll(filepath.Dir(p), 0o755)
		os.WriteFile(p, []byte(strings.Repeat("x", len(f))), 0o644)
	}

	// filepath.WalkDir: lexical order, skips with SkipDir.
	err = filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(dir, p)
		if d.IsDir() && d.Name() == "node_modules" {
			return filepath.SkipDir
		}
		kind := "file"
		if d.IsDir() {
			kind = "dir "
		}
		fmt.Println(kind, filepath.ToSlash(rel))
		return nil
	})
	if err != nil {
		log.Fatal(err)
	}

	matches, _ := filepath.Glob(filepath.Join(dir, "src", "*.go"))
	for _, m := range matches {
		fmt.Println("glob:", filepath.Base(m))
	}
}
```

```text
dir  .
file README.md
dir  docs
file docs/guide.md
dir  src
dir  src/internal
file src/internal/x.go
file src/main.go
file src/util.go
glob: main.go
glob: util.go
```

How `fn`'s return value steers the walk:

- `nil`: continue.
- `filepath.SkipDir` (on a directory): do not descend into it. Returned for a **file**, it
  skips the rest of the directory.
- `filepath.SkipAll`: stop the walk with no error.
- any other error: stop and return it.

Always check the `err` argument first. If the root does not exist, the function is called once
with that error and a nil `DirEntry`; calling `d.IsDir()` on it would panic. `WalkDir` does not
follow symbolic links to directories. The older `filepath.Walk` does a `Stat` of every entry and
is slower: prefer `WalkDir`.

`filepath.Glob(pattern)` returns the names that match a pattern in one directory level, sorted.
The pattern has no `**`; to match recursively, walk and test names with `filepath.Match`.

## io/fs: one interface for many file systems

An `fs.FS` has a single method, `Open(name string) (fs.File, error)`. The names are always
slash-separated, relative, and must pass `fs.ValidPath`: no leading `/`, no `.` or `..`
elements. The package `io/fs` builds the useful operations on top: `fs.ReadFile`, `fs.ReadDir`,
`fs.Stat`, `fs.Glob`, `fs.Sub` (a view of a subdirectory) and `fs.WalkDir`.

Code that takes an `fs.FS` instead of a directory name works on every source:

```go title="d/main.go"
package main

import (
	"fmt"
	"io/fs"
	"log"
	"os"
	"path/filepath"
	"strings"
	"testing/fstest"
)

// countLines works on any fs.FS: a directory, an embed.FS, a zip, a test map.
func countGo(fsys fs.FS) (files int, err error) {
	err = fs.WalkDir(fsys, ".", func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if !d.IsDir() && strings.HasSuffix(p, ".go") {
			files++
		}
		return nil
	})
	return files, err
}

func main() {
	// 1. An in-memory FS for tests.
	mem := fstest.MapFS{
		"main.go":      {Data: []byte("package main")},
		"pkg/a.go":     {Data: []byte("package pkg")},
		"pkg/notes.md": {Data: []byte("# notes")},
	}
	n, err := countGo(mem)
	fmt.Println(n, err)

	data, _ := fs.ReadFile(mem, "pkg/notes.md")
	fmt.Printf("%s\n", data)
	names, _ := fs.Glob(mem, "pkg/*")
	fmt.Println(names)
	sub, _ := fs.Sub(mem, "pkg")
	entries, _ := fs.ReadDir(sub, ".")
	for _, e := range entries {
		fmt.Println("sub:", e.Name())
	}

	// 2. A real directory: os.DirFS.
	dir, err := os.MkdirTemp("", "dirfs-*")
	if err != nil {
		log.Fatal(err)
	}
	defer os.RemoveAll(dir)
	os.WriteFile(filepath.Join(dir, "x.go"), []byte("package x"), 0o644)
	n, err = countGo(os.DirFS(dir))
	fmt.Println(n, err)

	// 3. io/fs paths are slash-separated and must be valid.
	fmt.Println(fs.ValidPath("a/b"), fs.ValidPath("/a"), fs.ValidPath("../a"), fs.ValidPath("a\b"))
	_, err = fs.ReadFile(mem, "/main.go")
	fmt.Println(err)
}
```

```text
2 <nil>
# notes
[pkg/a.go pkg/notes.md]
sub: a.go
sub: notes.md
1 <nil>
true false false true
open /main.go: file does not exist
```

Where the values come from:

| Source | How |
|---|---|
| A directory | `os.DirFS("dir")` |
| Files compiled into the binary | `embed.FS` ([[embed]]) |
| A zip archive | `zip.NewReader` is an `fs.FS` ([[compress]]) |
| A test tree | `testing/fstest.MapFS`, and `fstest.TestFS` to check your own implementation |
| A confined directory | `root.FS()` on an `*os.Root` |

`os.DirFS` does not stop `..` through symbolic links; its name checks are lexical. The
`MapFS` in the example is why `fs.FS` matters in tests: your function needs no temporary
directory.

> [!NOTE]
> Accept `fs.FS` in functions that only read. A function that takes `dir string` and calls
> `os.ReadFile` cannot be tested without touching the disk, and cannot read embedded assets.
> Functions that write still use `os` (there is no standard writable `fs.FS`).

linkcheck keeps its HTML report template inside the binary with `go:embed` in
[[step-7-reporters]]; it embeds a single file as a string, so it needs no `fs.FS`.
