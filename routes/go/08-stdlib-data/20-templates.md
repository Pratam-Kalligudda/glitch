---
title: text/template and html/template
---
A **template** is text with holes: the fixed parts are copied, and the **actions** in `{{ }}` are
replaced with values from the data you pass. Templates generate reports, e-mails, config files
and web pages. Go has two packages with one syntax and one important difference:

- **`text/template`** produces plain text and does no escaping.
- **`html/template`** has the same API and syntax but understands HTML, and **escapes every value
  for the place it appears** (text, attribute, URL, script). Use it for anything that ends up in
  a browser.

This stop teaches the syntax once with `text/template`, then what changes for HTML.

## Actions, pipelines and control flow

```go title="a/main.go"
package main

import (
	"log"
	"os"
	"strings"
	"text/template"
)

type Link struct {
	URL    string
	Status int
	Tags   []string
}

type Report struct {
	Site  string
	Links []Link
	Meta  map[string]string
}

const tpl = `Report for {{.Site}}
{{- range $i, $l := .Links}}
{{add1 $i}}. {{$l.URL | printf "%-24s"}} {{if eq $l.Status 200}}ok{{else if ge $l.Status 500}}SERVER ERROR{{else}}broken ({{$l.Status}}){{end}}
{{- with $l.Tags}} tags: {{join . ", "}}{{end}}
{{- end}}
{{if not .Links}}no links{{else}}{{len .Links}} links checked{{end}}
lang={{index .Meta "lang"}} missing={{.Meta.nope}}
`

func main() {
	funcs := template.FuncMap{
		"add1": func(i int) int { return i + 1 },
		"join": strings.Join,
	}
	t, err := template.New("report").Funcs(funcs).Parse(tpl)
	if err != nil {
		log.Fatal(err)
	}
	data := Report{
		Site: "example.com",
		Links: []Link{
			{"https://example.com/", 200, nil},
			{"https://example.com/old", 404, []string{"nav", "footer"}},
			{"https://example.com/api", 503, nil},
		},
		Meta: map[string]string{"lang": "en"},
	}
	if err := t.Execute(os.Stdout, data); err != nil {
		log.Fatal(err)
	}
}
```

```bash
go run ./a
```

```text
Report for example.com
1. https://example.com/     ok
2. https://example.com/old  broken (404) tags: nav, footer
3. https://example.com/api  SERVER ERROR
3 links checked
lang=en missing=<no value>
```

How it works:

- **`.` is the current value.** `Execute(w, data)` starts with `.` set to `data`. `{{.Site}}` reads
  the field `Site` of a struct, or the key of a map. Fields and methods must be **exported**.
- **A pipeline** passes the result of one command to the next, like a shell: `{{$l.URL | printf
  "%-24s"}}` formats the URL. The piped value becomes the **last** argument of the next function.
- **`range`** repeats a block for each element of a slice, array, map (in sorted key order),
  channel, integer (`{{range 3}}` gives 0, 1, 2) or iterator function. `{{range $i, $l := .Links}}` binds the index and element; inside, `.` is the
  element unless you named variables. `{{else}}` runs when the collection is empty.
- **`if`, `else if`, `else`, `end`**: false means the zero value: `false`, `0`, `""`, a nil pointer,
  an empty slice or map. `with` is `if` that also **sets `.`** to the value, and skips the block
  when it is empty (the `tags:` part).
- **Variables** start with `$` and are scoped to the block: `{{$x := .Name}}`, reassign with `=`.
  Use `$` alone to reach the root data from inside a `range`.
- **Whitespace**: `{{-` trims all white space before the action and `-}}` trims after it. Without
  them every newline in the template appears in the output. The example needs the dashes to keep each
  link on one line.
- **Built-in functions**: `eq ne lt le gt ge` (comparisons: `eq .A 1 2 3` is true if `.A` equals any),
  `and or not`, `len`, `index`, `slice`, `print printf println`, `html js urlquery`, `call`.
  Comparisons need matching types: `eq .Status "200"` with an int `Status` is an error.
- **Your own functions** go in a `template.FuncMap` given to `Funcs` **before** `Parse`, because
  the parser checks that every function exists (`add1` and `join` above).
- `{{/* comment */}}` is a comment.

Note the last line of the output: `.Meta.nope`, a map key that does not exist, printed
`<no value>`. That is the default; the next section shows how to make it an error.

## Errors: parse time and run time

```go title="b/main.go"
package main

import (
	"fmt"
	"os"
	"text/template"
)

func main() {
	// Parse errors: caught before running.
	_, err := template.New("x").Parse("{{.Name")
	fmt.Println(err)
	_, err = template.New("x").Parse("{{if .A}}open")
	fmt.Println(err)
	_, err = template.New("x").Parse("{{nofunc .A}}")
	fmt.Println(err)

	// Execute errors: found only when running.
	t := template.Must(template.New("x").Parse("hello {{.Name}}\n"))
	err = t.Execute(os.Stdout, struct{ Title string }{"t"})
	fmt.Println(err)
	err = t.Execute(os.Stdout, map[string]string{})
	fmt.Println("map missing key is silent:", err)

	t2 := template.Must(template.New("x").Option("missingkey=error").Parse("hello {{.Name}}\n"))
	err = t2.Execute(os.Stdout, map[string]string{})
	fmt.Println(err)

	// Unexported fields are not accessible.
	t3 := template.Must(template.New("x").Parse("{{.name}}"))
	fmt.Println(t3.Execute(os.Stdout, struct{ name string }{"n"}))
}
```

```text
template: x:1: unclosed action
template: x:1: unexpected EOF
template: x:1: function "nofunc" not defined
hello template: x:1:8: executing "x" at <.Name>: can't evaluate field Name in type struct { Title string }
hello <no value>
map missing key is silent: <nil>
hello template: x:1:8: executing "x" at <.Name>: map has no entry for key "Name"
template: x:1:2: executing "x" at <.name>: name is an unexported field of struct type struct { name string }
```

- **Parse errors** appear when you call `Parse`: unclosed actions, unclosed `if`, unknown functions.
  `template.Must(...)` panics on them, which suits a template compiled into your program: a broken
  template fails at startup, not in front of a user.
- **Execute errors** appear when the template runs: the field `Name` does not exist on the
  struct, or a field is unexported. Output written **before** the error has already reached the
  writer (`hello ` above), so render into a `bytes.Buffer` first when a half-written page would be
  worse than an error page.
- A missing key in a **map** is silent by default and prints `<no value>`. Set
  `.Option("missingkey=error")` to turn it into an error: usually what you want.

## Named templates, blocks and layouts

```go title="c/main.go"
package main

import (
	"log"
	"os"
	"text/template"
)

const tpl = `{{define "row"}}- {{.Name}}: {{.Count}}{{end -}}
{{define "page"}}# {{.Title}}
{{range .Rows}}{{template "row" .}}
{{end}}{{block "footer" .}}(default footer){{end}}
{{end -}}
{{template "page" .}}`

type Row struct {
	Name  string
	Count int
}

func main() {
	t := template.Must(template.New("root").Parse(tpl))
	data := map[string]any{
		"Title": "Counts",
		"Rows":  []Row{{"ok", 10}, {"broken", 2}},
	}
	if err := t.Execute(os.Stdout, data); err != nil {
		log.Fatal(err)
	}

	// Override the block in a clone.
	t2 := template.Must(template.Must(t.Clone()).Parse(`{{define "footer"}}-- custom footer --{{end}}`))
	if err := t2.ExecuteTemplate(os.Stdout, "page", data); err != nil {
		log.Fatal(err)
	}
}
```

```text
# Counts
- ok: 10
- broken: 2
(default footer)
# Counts
- ok: 10
- broken: 2
-- custom footer --
```

`{{define "name"}}...{{end}}` declares a template; `{{template "name" pipeline}}` calls it with the
value you pass (`.` inside the callee is that value). `{{block "name" .}}default{{end}}` defines
and calls in one step, and a later `define` of the same name, parsed into a **clone**, overrides it:
that is how a layout with replaceable parts works. A template set is shared by name, so
`t.ExecuteTemplate(w, "page", data)` runs one of them.

Templates in files: `template.ParseFiles("a.html", "b.html")`, `ParseGlob("templates/*.html")` or, to
compile them into the binary, `template.ParseFS(embedFS, "templates/*.html")` with `go:embed`
([[embed]]). Each file becomes a template named after its base file name.

## html/template: contextual escaping

The two packages are API-compatible: change the import and `Execute` runs the same. What differs is
that `html/template` parses the HTML around each action to know **where** the value lands, and escapes
for that context. Here the same template and data run through both:

```go title="d/main.go"
package main

import (
	"fmt"
	"html/template"
	"log"
	"os"
	texttemplate "text/template"
)

const page = `<a href="{{.URL}}" title="{{.Title}}">{{.Title}}</a>
<script>var user = {{.Title}};</script>
<p onclick="go({{.Title}})">{{.Title}}</p>
`

func main() {
	data := struct{ URL, Title string }{
		URL:   "https://example.com/?q=a b&x=1",
		Title: `</a><script>alert("hi")</script>`,
	}

	fmt.Println("--- html/template")
	h := template.Must(template.New("p").Parse(page))
	if err := h.Execute(os.Stdout, data); err != nil {
		log.Fatal(err)
	}

	fmt.Println("--- text/template")
	t := texttemplate.Must(texttemplate.New("p").Parse(page))
	if err := t.Execute(os.Stdout, data); err != nil {
		log.Fatal(err)
	}
}
```

```text
--- html/template
<a href="https://example.com/?q=a%20b&amp;x=1" title="&lt;/a&gt;&lt;script&gt;alert(&#34;hi&#34;)&lt;/script&gt;">&lt;/a&gt;&lt;script&gt;alert(&#34;hi&#34;)&lt;/script&gt;</a>
<script>var user = "\u003c/a\u003e\u003cscript\u003ealert(\"hi\")\u003c/script\u003e";</script>
<p onclick="go(&#34;\u003c/a\u003e\u003cscript\u003ealert(\&#34;hi\&#34;)\u003c/script\u003e&#34;)">&lt;/a&gt;&lt;script&gt;alert(&#34;hi&#34;)&lt;/script&gt;</p>
--- text/template
<a href="https://example.com/?q=a b&x=1" title="</a><script>alert("hi")</script>"></a><script>alert("hi")</script></a>
<script>var user = </a><script>alert("hi")</script>;</script>
<p onclick="go(</a><script>alert("hi")</script>)"></a><script>alert("hi")</script></p>
```

Read the `html/template` output top to bottom. The title was `</a><script>alert("hi")</script>`:

- In **element text** it is HTML-escaped (`&lt;`, `&#34;`), so it shows as text.
- In an **attribute** (`title="..."`) it is escaped for an attribute value.
- In a **URL** (`href`), the spaces and unsafe characters are percent-encoded and `&` becomes `&amp;`.
- Inside **`<script>`** it becomes a valid JavaScript string literal (`"</a>..."`), and in an
  **event handler** attribute both layers of escaping are applied.

`text/template` pasted the raw string everywhere. The output closes the link and runs the script: a
**cross-site scripting (XSS)** hole whenever the data comes from a user, from a database, or from a
page you crawled.

> [!WARNING]
> Using `text/template` for HTML. Symptom: it works in every test, until a value contains `<`, `&` or
> a quote: broken markup, or an attacker's script running on your page. Fix: import
> `html/template` for every template whose output is HTML (including e-mail bodies sent as HTML). The
> import line is the entire change.

### Trusted types and what is refused

```go title="e/main.go"
package main

import (
	"html/template"
	"log"
	"os"
)

func main() {
	t := template.Must(template.New("p").Parse(`<a href="{{.Link}}">x</a> {{.Raw}} {{.Trusted}}
`))
	err := t.Execute(os.Stdout, map[string]any{
		"Link":    "javascript:alert(1)",
		"Raw":     "<b>bold</b>",
		"Trusted": template.HTML("<b>bold</b>"), // you vouch that this is safe HTML
	})
	if err != nil {
		log.Fatal(err)
	}

}
```

```text
<a href="#ZgotmplZ">x</a> &lt;b&gt;bold&lt;/b&gt; <b>bold</b>
```

- A URL with a dangerous scheme, such as `javascript:`, is replaced by `#ZgotmplZ`. Seeing
  `ZgotmplZ` in your HTML means the escaper refused a value in that context.
- A plain string containing HTML is escaped (`&lt;b&gt;`). To insert **HTML you wrote and trust**,
  pass it as `template.HTML`, and similarly `template.URL`, `template.JS`, `template.CSS`,
  `template.HTMLAttr`. That is you telling the package "do not escape this". Never convert
  user-controlled text with `template.HTML(s)`: that disables the protection.
- Escaping depends on the template text being well-formed HTML. Putting actions inside an unquoted
  attribute, inside a tag name, or in an odd place makes `Execute` return an error like
  `... ends in a non-text context`; fix the template instead of silencing it.

### A layout from embedded files

The usual shape is a layout file with the shared structure and small partials, all embedded in the
binary:

```html title="f/templates/layout.html"
<!doctype html>
<title>{{block "title" .}}Report{{end}}</title>
<h1>{{template "heading" .}}</h1>
<ul>
{{range .Links}}  <li>{{template "link" .}}</li>
{{end}}</ul>
```

```html title="f/templates/link.html"
{{define "link"}}<a href="{{.URL}}">{{.URL}}</a> {{.Status}}{{end}}
{{define "heading"}}Links for {{.Site}}{{end}}
```

```go title="f/main.go"
package main

import (
	"embed"
	"html/template"
	"log"
	"os"
)

//go:embed templates/*.html
var files embed.FS

func main() {
	t, err := template.ParseFS(files, "templates/*.html")
	if err != nil {
		log.Fatal(err)
	}
	data := map[string]any{
		"Site": "example.com",
		"Links": []map[string]any{
			{"URL": "https://example.com/a?x=1&y=2", "Status": 200},
			{"URL": "javascript:evil()", "Status": 404},
		},
	}
	if err := t.ExecuteTemplate(os.Stdout, "layout.html", data); err != nil {
		log.Fatal(err)
	}
}
```

```text
<!doctype html>
<title>Report</title>
<h1>Links for example.com</h1>
<ul>
  <li><a href="https://example.com/a?x=1&amp;y=2">https://example.com/a?x=1&amp;y=2</a> 200</li>
  <li><a href="#ZgotmplZ">javascript:evil()</a> 404</li>
</ul>
```

`ParseFS` loaded both files into one set. `layout.html` calls the `heading` and `link` templates that
`link.html` defines, and the `block "title"` shows its default. The unsafe link was neutralised
automatically. In a real server you parse the templates **once** at start-up into a package-level
variable and call `Execute` per request ([[http-server]]); parsing is the expensive step, and a parsed
`*template.Template` is safe for concurrent `Execute` calls.

| Need | Use |
|---|---|
| HTML output | `html/template` |
| E-mail text, config files, code generation, logs | `text/template` |
| Fail on typos in data keys | `Option("missingkey=error")` |
| Own helper function | `Funcs(template.FuncMap{...})` before `Parse` |
| Compile templates into the binary | `ParseFS` with `embed.FS` |

linkcheck renders its HTML report with `html/template` from an embedded file, and `--serve` serves it with
`net/http`, in [[step-7-reporters]].
