---
title: encoding/csv
---
CSV (comma-separated values) is the format spreadsheets and data exports speak. It looks
trivial and is not: fields may be quoted, quoted fields may contain commas, quotes and line
breaks, and "CSV" in the wild varies in separator, quoting and line endings. `encoding/csv`
implements RFC 4180 with a few switches for the common variations. It reads and writes
records: a record is one row, a `[]string`. The package knows nothing about types or headers;
you convert with `strconv` ([[strconv]]).

## Reading

```go title="a/main.go"
package main

import (
	"encoding/csv"
	"fmt"
	"io"
	"log"
	"strconv"
	"strings"
)

const data = `url,status,note
https://a.example,200,ok
https://b.example/?q=1,404,"not found, moved"
https://c.example,500,"said ""boom""
and then stopped"
`

type Row struct {
	URL    string
	Status int
	Note   string
}

func main() {
	r := csv.NewReader(strings.NewReader(data))

	header, err := r.Read()
	if err != nil {
		log.Fatal(err)
	}
	fmt.Println("header:", header)

	var rows []Row
	for {
		rec, err := r.Read()
		if err == io.EOF {
			break
		}
		if err != nil {
			log.Fatal(err)
		}
		status, err := strconv.Atoi(rec[1])
		if err != nil {
			log.Fatal(err)
		}
		rows = append(rows, Row{rec[0], status, rec[2]})
		line, col := r.FieldPos(2)
		fmt.Printf("%q (field 2 starts at line %d, column %d)\n", rec[2], line, col)
	}
	fmt.Printf("%+v\n", rows[2])
}
```

```bash
go run ./a
```

```text
header: [url status note]
"ok" (field 2 starts at line 2, column 23)
"not found, moved" (field 2 starts at line 3, column 28)
"said \"boom\"\nand then stopped" (field 2 starts at line 4, column 23)
{URL:https://c.example Status:500 Note:said "boom"
and then stopped}
```

How it works:

- `csv.NewReader(r)` wraps any `io.Reader` and buffers internally; you do not need `bufio`.
- `r.Read()` returns the next record as a `[]string`, and `io.EOF` after the last one. The loop
  tests for `io.EOF` **before** any other error, as with other readers ([[bufio]]).
- The first `Read` returned the header row. The package does not treat it specially; if you want
  to find columns by name, build a `map[string]int` from it and index with that, so a reordered
  export does not break the code.
- A **quoted field** can contain the separator (`"not found, moved"`), a doubled quote for a
  literal quote (`""boom""` becomes `"boom"`) and a line break. The last record
  starts on line 4 and ends on line 5; line numbers in errors and `FieldPos` say where a
  record or field *begins*.
- `r.FieldPos(i)` returns the line and column where field `i` of the last record started, for
  error messages that point at the data.
- Every field is text. `rec[1]` is `"200"`: convert it, check the error, and say which line was
  bad.

`r.ReadAll()` reads everything into a `[][]string`: convenient for small files, but it holds the
whole file in memory. For large inputs loop with `Read`, and set `r.ReuseRecord = true` to reuse
the slice between calls (then copy anything you keep, as in [[bytes-buffer]]).

## Dialects and errors

The `Reader` fields adapt it to the file you have. Each case below runs the same input through
a differently configured reader:

```go title="b/main.go"
package main

import (
	"encoding/csv"
	"errors"
	"fmt"
	"strings"
)

func readAll(label, in string, configure func(*csv.Reader)) {
	r := csv.NewReader(strings.NewReader(in))
	if configure != nil {
		configure(r)
	}
	recs, err := r.ReadAll()
	fmt.Printf("%s: %q err=%v\n", label, recs, err)
	var pe *csv.ParseError
	if errors.As(err, &pe) {
		fmt.Printf("   line %d column %d: %v (is ErrFieldCount: %v)\n",
			pe.Line, pe.Column, pe.Err, errors.Is(err, csv.ErrFieldCount))
	}
}

func main() {
	readAll("ragged", "a,b,c\n1,2\n", nil)
	readAll("ragged ok", "a,b,c\n1,2\n", func(r *csv.Reader) { r.FieldsPerRecord = -1 })
	readAll("bare quote", "a,b\"c,d\n", nil)
	readAll("lazy quotes", "a,b\"c,d\n", func(r *csv.Reader) { r.LazyQuotes = true })
	readAll("semicolon", "a;b;c\n1;2;3\n", func(r *csv.Reader) { r.Comma = ';' })
	readAll("comments", "# skip me\na,b\n", func(r *csv.Reader) { r.Comment = '#' })
	readAll("spaces", "a, b, c\n", func(r *csv.Reader) { r.TrimLeadingSpace = true })
	readAll("blank lines", "a,b\n\n\nc,d\n", nil)
	readAll("empty", "", nil)
	readAll("unterminated", "a,\"b\n", nil)
	readAll("BOM", "\xef\xbb\xbfid,name\n1,x\n", nil)
}
```

```text
ragged: [] err=record on line 2: wrong number of fields
   line 2 column 1: wrong number of fields (is ErrFieldCount: true)
ragged ok: [["a" "b" "c"] ["1" "2"]] err=<nil>
bare quote: [] err=parse error on line 1, column 4: bare " in non-quoted-field
   line 1 column 4: bare " in non-quoted-field (is ErrFieldCount: false)
lazy quotes: [["a" "b\"c" "d"]] err=<nil>
semicolon: [["a" "b" "c"] ["1" "2" "3"]] err=<nil>
comments: [["a" "b"]] err=<nil>
spaces: [["a" "b" "c"]] err=<nil>
blank lines: [["a" "b"] ["c" "d"]] err=<nil>
empty: [] err=<nil>
unterminated: [] err=parse error on line 1, column 6: extraneous or missing " in quoted-field
   line 1 column 6: extraneous or missing " in quoted-field (is ErrFieldCount: false)
BOM: [["\ufeffid" "name"] ["1" "x"]] err=<nil>
```

| Field | Meaning |
|---|---|
| `Comma` | Field separator (default `,`). Use `';'` for many European exports and `'\t'` for TSV |
| `Comment` | A line starting with this rune is skipped |
| `FieldsPerRecord` | `0` (default): every record must have as many fields as the **first**. Positive: exactly that many. Negative: no check |
| `LazyQuotes` | Accept a bare `"` inside an unquoted field and a quote inside a quoted one |
| `TrimLeadingSpace` | Ignore white space after the separator |
| `ReuseRecord` | Reuse the returned slice between `Read` calls |

What the output shows:

- A row with a different field count than the first fails with `csv.ErrFieldCount` wrapped in a
  `*csv.ParseError` (`line 2 column 1`). Set `FieldsPerRecord = -1` for ragged data.
- A stray quote is a `ParseError` with a `Line`, a `Column` and an `Err` such as
  `bare " in non-quoted-field`. Use `errors.As` ([[is-as]]) for the position and `errors.Is`
  for `csv.ErrFieldCount`, `csv.ErrBareQuote` and `csv.ErrQuote`.
- **Blank lines are skipped**, and an empty input is an empty result, not an error.
- **On a parse error, `ReadAll` returns no records at all**, so one bad line loses the file.
  When you want the good rows too, loop with `Read`, as below.
- **A UTF-8 byte order mark is not removed.** Excel writes one at the start of "CSV UTF-8" files,
  so the first header becomes `"﻿id"` and a lookup of `"id"` fails. Strip it before parsing:
  `bytes.TrimPrefix(data, []byte("\xef\xbb\xbf"))`, or peek three bytes with a `bufio.Reader`.

`Read` keeps going after an error. For a wrong field count it returns the record **and** the
error; for a syntax error it returns an empty record and moves to the next line:

```go title="e/main.go"
package main

import (
	"encoding/csv"
	"fmt"
	"io"
	"strings"
)

func main() {
	r := csv.NewReader(strings.NewReader("a,b\n1,2,3\nx\"y,z\nc,d\n"))
	for {
		rec, err := r.Read()
		if err == io.EOF {
			break
		}
		fmt.Printf("%q %v\n", rec, err)
	}
}
```

```text
["a" "b"] <nil>
["1" "2" "3"] record on line 2: wrong number of fields
[] parse error on line 3, column 2: bare " in non-quoted-field
["c" "d"] <nil>
```

Log the bad line and continue, or stop, as the data deserves.

> [!WARNING]
> A header lookup that fails only on files saved by Excel is the byte order mark. Symptom:
> `column "id" not found` although the header visibly says `id`, and `%q` of the header shows
> `﻿` in front. Fix: remove the BOM before creating the `csv.Reader`.

## Writing

```go title="c/main.go"
package main

import (
	"encoding/csv"
	"fmt"
	"log"
	"os"
	"strconv"
)

type Row struct {
	URL    string
	Status int
	Note   string
}

func main() {
	rows := []Row{
		{"https://a.example", 200, ""},
		{"https://b.example/?q=1", 404, "not found, moved"},
		{"https://c.example", 500, `said "boom"` + "\nthen stopped"},
		{"https://d.example", 200, " padded "},
	}

	w := csv.NewWriter(os.Stdout)
	if err := w.Write([]string{"url", "status", "note"}); err != nil {
		log.Fatal(err)
	}
	for _, r := range rows {
		if err := w.Write([]string{r.URL, strconv.Itoa(r.Status), r.Note}); err != nil {
			log.Fatal(err)
		}
	}
	w.Flush() // buffered: nothing is written until Flush
	if err := w.Error(); err != nil {
		log.Fatal(err)
	}

	fmt.Println("---")
	w = csv.NewWriter(os.Stdout)
	w.Comma = '\t'
	w.UseCRLF = true
	w.WriteAll([][]string{{"a", "b c"}, {"1", "2"}}) // WriteAll flushes
}
```

```text
url,status,note
https://a.example,200,
https://b.example/?q=1,404,"not found, moved"
https://c.example,500,"said ""boom""
then stopped"
https://d.example,200," padded "
---
a	b c
1	2
```

`w.Write(record)` quotes only the fields that need it: those containing the separator, a quote, a
line break, or starting with a space (` padded ` above). Quotes inside are doubled. `Write` goes to
an internal buffer, so you must call **`w.Flush()`** and then check **`w.Error()`**. Forgetting the
flush loses the last rows, exactly like `bufio.Writer` ([[bufio]]). `WriteAll` writes all the
records and flushes for you. `Comma` and `UseCRLF` (write `\r\n` line endings, as Windows
tools expect) choose the dialect.

Values must be converted to strings first. Format numbers with `strconv.Itoa` and
`strconv.FormatFloat`, and times with `t.Format(time.RFC3339)` ([[time-pkg]]).

> [!WARNING]
> A spreadsheet treats a field that starts with `=`, `+`, `-` or `@` as a formula. A URL or a note
> taken from the web and written to CSV can therefore run a formula when someone opens the file
> (CSV injection). If you export untrusted text for spreadsheets, prefix such fields with a
> single quote or a tab.

linkcheck's CSV reporter writes one row per checked link with a `csv.Writer` over any
`io.Writer`, in [[step-7-reporters]].
