---
title: encoding/xml
---
XML is older than JSON and still everywhere: Atom and RSS feeds, SVG, Office files, SOAP, and
CI test reports such as JUnit. `encoding/xml` works like `encoding/json` ([[json]]): you describe the
document with struct tags, then `Marshal` and `Unmarshal` convert. XML has more concepts than
JSON, so the tags carry more: **elements** (`<a>`), **attributes** (`<a id="1">`), **text**
between tags, comments and namespaces.

## Marshal: building a document

```go title="a/main.go"
package main

import (
	"encoding/xml"
	"fmt"
	"log"
	"os"
)

// TestSuite follows the JUnit report layout.
type TestSuite struct {
	XMLName  xml.Name   `xml:"testsuite"`
	Name     string     `xml:"name,attr"`
	Tests    int        `xml:"tests,attr"`
	Failures int        `xml:"failures,attr"`
	Cases    []TestCase `xml:"testcase"`
}

type TestCase struct {
	Name    string   `xml:"name,attr"`
	Time    float64  `xml:"time,attr,omitempty"`
	Failure *Failure `xml:"failure,omitempty"`
	Output  string   `xml:"system-out,omitempty"`
}

type Failure struct {
	Message string `xml:"message,attr"`
	Text    string `xml:",chardata"`
}

func main() {
	s := TestSuite{
		Name:  "linkcheck",
		Tests: 2,
		Cases: []TestCase{
			{Name: "https://a.example", Time: 0.25},
			{Name: "https://b.example/?a=1&b=2", Failure: &Failure{Message: "status 404", Text: "not found <b>"}},
		},
	}
	s.Failures = 1

	out, err := xml.MarshalIndent(s, "", "  ")
	if err != nil {
		log.Fatal(err)
	}
	os.Stdout.WriteString(xml.Header)
	os.Stdout.Write(out)
	fmt.Println()
}
```

```bash
go run ./a
```

```text
<?xml version="1.0" encoding="UTF-8"?>
<testsuite name="linkcheck" tests="2" failures="1">
  <testcase name="https://a.example" time="0.25"></testcase>
  <testcase name="https://b.example/?a=1&amp;b=2">
    <failure message="status 404">not found &lt;b&gt;</failure>
  </testcase>
</testsuite>
```

This is the layout of a JUnit report, the format CI systems read for test results, and the one
linkcheck writes in [[step-7-reporters]]. The tags:

| Tag | Meaning |
|---|---|
| `xml:"name"` | Write the field as a child element `<name>` |
| `xml:"name,attr"` | Write it as an attribute of the enclosing element |
| `xml:",chardata"` | Write the value as the element's text |
| `xml:",cdata"` | Write the text inside a `<![CDATA[...]]>` section |
| `xml:",comment"` | Write it as an XML comment |
| `xml:",innerxml"` | Write (or read) the raw inner XML without escaping |
| `xml:"a>b>c"` | Nest the field inside `<a><b>`, creating the parents |
| `xml:",any"` | When reading: collect child elements that no other field matched |
| `xml:",omitempty"` | Omit the field when it is empty or zero |
| `xml:"-"` | Skip the field |

An `XMLName xml.Name` field, with a tag, names the root element: without it the root is named after
the type. A slice field becomes **repeated elements** (one `<testcase>` for each item), a
pointer is omitted when `nil` (the passing case has no `<failure>`), and a `float64` is
written with the shortest form that reads back exactly.

Things to know about the output:

- **Text is escaped for you**: `&` is `&amp;` and `<` is `&lt;`, in attributes and text. Never build
  XML by joining strings; use `xml.EscapeText` for the rare case you must write text by hand.
- **There is no XML declaration unless you add it.** `xml.Header` is the constant
  `<?xml version="1.0" encoding="UTF-8"?>` plus a newline. Write it yourself first.
- **Empty elements are written as `<a></a>`**, never `<a/>`. Both are the same XML.
- `xml.MarshalIndent(v, prefix, indent)` formats it for people; `xml.Marshal` does not.
- **Maps are not supported**: `Marshal` returns `xml: unsupported type: map[string]int`. Use a
  slice of structs with key and value fields.

## Unmarshal: reading a document

```go title="b/main.go"
package main

import (
	"encoding/xml"
	"fmt"
)

type Feed struct {
	XMLName xml.Name `xml:"feed"`
	Title   string   `xml:"title"`
	Link    struct {
		Href string `xml:"href,attr"`
	} `xml:"link"`
	Entries []Entry  `xml:"entry"`
	Authors []string `xml:"meta>authors>name"`
	Raw     string   `xml:",innerxml"`
}

type Entry struct {
	ID      string `xml:"id"`
	Title   string `xml:"title"`
	Summary string `xml:"summary"`
	Draft   bool   `xml:"draft,attr"`
}

const doc = `<?xml version="1.0" encoding="UTF-8"?>
<!-- a comment -->
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Go &amp; friends</title>
  <link href="https://go.dev/"/>
  <meta><authors><name>Ann</name><name>Bo</name></authors></meta>
  <entry draft="true"><id>1</id><title>First</title><summary><![CDATA[a < b]]></summary></entry>
  <entry><id>2</id><title>Second</title></entry>
</feed>`

func main() {
	var f Feed
	if err := xml.Unmarshal([]byte(doc), &f); err != nil {
		fmt.Println(err)
		return
	}
	fmt.Println(f.XMLName.Local, f.XMLName.Space)
	fmt.Println(f.Title, f.Link.Href, f.Authors)
	for _, e := range f.Entries {
		fmt.Printf("%+v\n", e)
	}
	fmt.Println(len(f.Raw) > 0)

	var bad Feed
	fmt.Println(xml.Unmarshal([]byte(`<feed><title>x</feed>`), &bad))
	fmt.Println(xml.Unmarshal([]byte(`<other/>`), &bad))
}
```

```text
feed http://www.w3.org/2005/Atom
Go & friends https://go.dev/ [Ann Bo]
{ID:1 Title:First Summary:a < b Draft:true}
{ID:2 Title:Second Summary: Draft:false}
true
XML syntax error on line 1: element <title> closed by </feed>
expected element type <feed> but have <other>
```

What to read from this:

- The **root element's name** is checked when the struct has an `XMLName` with a tag: `<other/>`
  against `xml:"feed"` fails with `expected element type <feed> but have <other>`.
- **Namespaces**: `xmlns="http://www.w3.org/2005/Atom"` ended up in `XMLName.Space`. An element
  tag can require a namespace by writing it in front of the name: `xml:"http://www.w3.org/2005/Atom title"`.
- **`a>b>c`** reaches into nested elements: `meta>authors>name` collected both authors into a
  slice.
- Entities and CDATA are decoded: `&amp;` became `&`, and the CDATA `a < b` is plain text.
- Missing elements leave the field at its zero value (`Summary` of entry 2).
- A syntax error names the line: `XML syntax error on line 1: element <title> closed by </feed>`.
- **Encoding**: Go reads UTF-8 only. A document that declares `ISO-8859-1` fails with
  `xml: encoding "ISO-8859-1" declared but Decoder.CharsetReader is nil` until you set
  `Decoder.CharsetReader` (the `golang.org/x/net/html/charset` package provides one).

## Streaming big documents

`Unmarshal` needs the whole document in memory. For a large file, create a `Decoder` over an
`io.Reader` and pull tokens one at a time, decoding only the elements you need:

```go title="c/main.go"
package main

import (
	"encoding/xml"
	"fmt"
	"io"
	"strings"
)

func main() {
	const doc = `<rows><row id="1">alpha</row><row id="2">beta</row><skip/><row id="3">gamma</row></rows>`
	dec := xml.NewDecoder(strings.NewReader(doc))

	type Row struct {
		ID   string `xml:"id,attr"`
		Text string `xml:",chardata"`
	}
	for {
		tok, err := dec.Token()
		if err == io.EOF {
			break
		}
		if err != nil {
			fmt.Println(err)
			return
		}
		if se, ok := tok.(xml.StartElement); ok && se.Name.Local == "row" {
			var r Row
			if err := dec.DecodeElement(&r, &se); err != nil {
				fmt.Println(err)
				return
			}
			fmt.Printf("%+v\n", r)
		}
	}
}
```

```text
{ID:1 Text:alpha}
{ID:2 Text:beta}
{ID:3 Text:gamma}
```

`dec.Token()` returns the next `xml.Token`: a `StartElement`, `EndElement`, `CharData`, `Comment`,
`ProcInst` or `Directive`. Test the type with a type assertion or switch ([[assertions-switches]]).
Call `dec.DecodeElement(&v, &start)` when you reach an element you want to read as a struct; it
consumes through the matching end tag. The decoder skips `<skip/>` simply by not decoding it.
Memory use stays flat however many rows the file has. Do not keep `CharData` tokens past the next
call to `Token`, because the bytes are reused (use `xml.CopyToken` when you must).

The matching writer is `xml.NewEncoder(w)` with `Indent`, and `EncodeToken` to build documents
piece by piece:

```go title="d/main.go"
package main

import (
	"encoding/xml"
	"fmt"
	"strings"
)

type Note struct {
	Text string `xml:",chardata"`
	Body string `xml:"body"`
}

type Doc struct {
	Name   string         `xml:"name"`
	Counts map[string]int `xml:"counts"`
}

func main() {
	var buf strings.Builder
	enc := xml.NewEncoder(&buf)
	enc.Indent("", " ")
	err := enc.Encode(Note{Text: "hi", Body: "a & b"})
	fmt.Println(buf.String(), err)

	_, err = xml.Marshal(Doc{Name: "x", Counts: map[string]int{"a": 1}})
	fmt.Println(err)

	var sb strings.Builder
	xml.EscapeText(&sb, []byte(`5 < 6 & "7"`))
	fmt.Println(sb.String())
}
```

```text
<Note>hi
 <body>a &amp; b</body>
</Note> <nil>
xml: unsupported type: map[string]int
5 &lt; 6 &amp; &#34;7&#34;
```

> [!WARNING]
> Mixing text and elements in one struct is easy to get wrong. Symptom: a `chardata` field
> that holds white space and newlines from the indentation of the source XML, or text that is
> missing because the field tag names an element rather than the text. Fix: use `,chardata` for
> the text of the element itself, an element tag for children, and `strings.TrimSpace` on text
> from pretty-printed documents.

> [!NOTE]
> The decoder does not fetch external entities or DTDs, so a document cannot make it read files
> or URLs. It still reads whatever size the input has: wrap untrusted input with
> `io.LimitReader`, as for any reader ([[io-composition]]). `Decoder.Strict` is `true` by default;
> setting it to `false` accepts the sloppy markup of old HTML-ish feeds.

linkcheck's JUnit reporter uses `name`, `attr`, `chardata`, `omitempty` and an `XMLName` field
from the list above in [[step-7-reporters]].
