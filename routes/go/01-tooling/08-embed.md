---
title: Embedding files with go:embed
done_when: "Your binary renders a template and prints a version file after you move the binary to another directory, and you can name which files `//go:embed static` leaves out."
---
A program often needs files that are not Go code: HTML templates, CSS, a default config, a
SQL schema, a version file. Reading them from disk at run time means shipping them next to
the binary and finding them again from wherever the binary was started. The `//go:embed`
directive copies files into the binary at build time instead, so the single-file program
from [[cross-compile]] stays a single file.

## Embedding a version, a stylesheet and templates

```text
report/
  go.mod
  main.go
  VERSION                         v1.2.0
  templates/report.html
  templates/partials/footer.html
  static/style.css
  static/.env                     a hidden file
  static/_draft.css               a file starting with _
```

```text title="templates/report.html"
<h1>{{.Title}}</h1>
{{template "footer.html" .}}
```

```text title="templates/partials/footer.html"
<footer>{{len .Links}} links checked</footer>
```

```go title="main.go"
package main

import (
	"embed"
	"fmt"
	"html/template"
	"io/fs"
	"os"
	"strings"
)

//go:embed VERSION
var version string

//go:embed static/style.css
var css []byte

//go:embed templates
var templates embed.FS

//go:embed static
var static embed.FS

//go:embed all:static
var staticAll embed.FS

func main() {
	fmt.Printf("version %q, css %d bytes\n", strings.TrimSpace(version), len(css))

	for _, fsys := range []embed.FS{templates, static, staticAll} {
		fs.WalkDir(fsys, ".", func(path string, d fs.DirEntry, err error) error {
			if err != nil {
				return err
			}
			if !d.IsDir() {
				fmt.Print(path, " ")
			}
			return nil
		})
		fmt.Println()
	}

	t := template.Must(template.ParseFS(templates, "templates/*.html", "templates/partials/*.html"))
	data := struct {
		Title string
		Links []string
	}{"Report", []string{"a", "b", "c"}}
	if err := t.ExecuteTemplate(os.Stdout, "report.html", data); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
```

```bash
go run .
```

```text
version "v1.2.0", css 34 bytes
templates/partials/footer.html templates/report.html 
static/style.css 
static/.env static/_draft.css static/style.css 
<h1>Report</h1>
<footer>3 links checked</footer>
```

Build it, then delete or rename `VERSION` on disk and run the binary again: it still prints
`version "v1.2.0"`. The files are in the binary.

## How it works

`//go:embed` is a directive, a comment the compiler reads. It must sit directly above a
**package-level** `var` declaration and lists one or more patterns. The file must import
`embed` (a blank `import _ "embed"` is enough when you only embed into a `string` or
`[]byte`). At build time the `go` command resolves the patterns relative to the directory
of the source file, reads the files and stores their contents in the binary; the variable
is initialised with them before `main` runs.

The variable's type decides what you get:

| Type | Gets | Patterns |
|---|---|---|
| `string` | The contents of one file | Exactly one file |
| `[]byte` | The contents of one file | Exactly one file |
| `embed.FS` | A read-only file tree | Any number of files and directories |

`embed.FS` implements `fs.FS`, the standard library's file system interface, so anything
that accepts an `fs.FS` works with it: `template.ParseFS`, `fs.WalkDir`, `fs.ReadFile`,
`http.FileServerFS`. Paths inside it are the paths you embedded, with forward slashes,
relative to the package directory: `templates/report.html`, not `report.html`. That is why
the code above walks from `"."` and globs `templates/*.html`.

**Which files a directory pattern includes.** Embedding a directory includes every file
below it, recursively, **except** names that start with `.` or `_`. `static` gave only
`style.css`; `all:static` also took `.env` and `_draft.css`. The default exists so that
editor swap files, `.git` folders and `.DS_Store` files do not end up in your binary. A
pattern that names a hidden file directly (`//go:embed static/.env`) does include it.

**What may be embedded.** Only files inside the module and in the package's directory tree.
Patterns use `path.Match` syntax (`*`, `?`, `[a-z]`) and may not contain `.` or `..`
elements, may not start or end with `/`, and may not match files in another module (a
subdirectory with its own go.mod), symlinks, or irregular files.

Every rule is checked at build time. The errors:

```text
a.go:5:12: pattern missing.txt: no matching files found
a.go:5:12: pattern ../top.txt: invalid pattern syntax
a.go:5:20: pattern sub: cannot embed directory sub: contains no embeddable files
./a.go:6:5: invalid go:embed: multiple files for type string
.\a.go:5:3: go:embed requires import "embed" (or import _ "embed", if package is not used)
.\a.go:9:4: go:embed cannot apply to var inside func
```

## Trade-offs

Embedded files cost binary size and are fixed at build time: changing a template means
rebuilding. In return the program cannot fail at run time because a file is missing or the
working directory is wrong. A common pattern is to embed defaults and let a flag point at a
directory on disk during development:

```go title="dirfs.go"
package main

import (
	"io/fs"
	"os"
)

// templateFS returns the embedded templates, or the directory dir on disk
// when dir is set, so templates can be edited without rebuilding.
func templateFS(dir string) (fs.FS, error) {
	if dir == "" {
		return fs.Sub(templates, "templates")
	}
	return os.DirFS(dir), nil
}
```

`fs.Sub` returns a view of the embedded tree rooted at `templates/`, so both branches serve
`report.html` under the same name. Because `embed.FS`, `fs.Sub` and `os.DirFS` all give an
`fs.FS`, the rest of the code does not care which one it got. You will meet `fs.FS` again in [[filepath-fs]].

> [!WARNING]
> The classic surprise is a missing file at run time: a file server built on
> `//go:embed static` has no `.well-known/` directory or `_headers` file, and answers 404
> for them. Nothing failed at build time, because hidden and underscore files are
> skipped silently. Use `all:static`, or name those files explicitly in the pattern. The
> second surprise is opening `report.html` instead of `templates/report.html`: the FS keeps
> the directory prefix. Use `fs.Sub(templates, "templates")` to get a view rooted inside it.

> [!NOTE]
> `//go:embed` arrived in Go 1.16. The package documentation, with every rule above, is at
> <https://pkg.go.dev/embed>.

linkcheck's HTML reporter in [[step-7-reporters]] ships its `html/template` inside the
binary this way.
