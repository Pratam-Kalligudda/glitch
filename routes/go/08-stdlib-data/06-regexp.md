---
title: Regular expressions
---
The `regexp` package matches text against a pattern: find, extract parts, replace, split.
Go's engine follows RE2 syntax. Its defining property is that matching time is **linear in the
size of the input**, whatever the pattern. A hostile pattern or input cannot make it hang the
way backtracking engines (Perl, Python, JavaScript, Java) can ("catastrophic backtracking").
The price is that features which need backtracking do not exist: no backreferences (`\1` in the
pattern) and no lookahead or lookbehind (`(?=...)`, `(?<=...)`).

Write patterns in **raw string literals** (back quotes) so you type `\d` and not `\d`.

## Compile once, match many times

```go title="a/main.go"
package main

import (
	"fmt"
	"regexp"
)

// Compiled once, at package initialisation. MustCompile panics on a bad pattern,
// which is what you want for a constant pattern: the bug shows at startup.
var versionRe = regexp.MustCompile(`v(\d+)\.(\d+)\.(\d+)`)

func main() {
	text := "upgrade from v1.26.3 to v1.27.1 now"

	fmt.Println(versionRe.MatchString(text))
	fmt.Println(versionRe.FindString(text))
	fmt.Println(versionRe.FindStringIndex(text))
	fmt.Println(versionRe.FindStringSubmatch(text))
	fmt.Println(versionRe.FindAllString(text, -1))
	fmt.Println(versionRe.FindAllStringSubmatch(text, -1))
	fmt.Println(versionRe.FindAllString(text, 1))
	fmt.Println(versionRe.FindString("nothing here") == "")
	fmt.Println(versionRe.FindStringSubmatch("nothing here") == nil)
	fmt.Println(versionRe.NumSubexp(), versionRe.String())
}
```

```bash
go run ./a
```

```text
true
v1.26.3
[13 20]
[v1.26.3 1 26 3]
[v1.26.3 v1.27.1]
[[v1.26.3 1 26 3] [v1.27.1 1 27 1]]
[v1.26.3]
true
true
3 v(\d+)\.(\d+)\.(\d+)
```

`regexp.MustCompile` parses the pattern into a program and **panics** if the pattern is
invalid. Use it for patterns written in source, in a package-level `var`, so a typo fails at
startup rather than in the middle of a request. `regexp.Compile` returns an error instead, for
patterns that come from users or config.

The result, a `*regexp.Regexp`, is immutable and safe for concurrent use by many goroutines,
so one package-level variable serves the whole program.

### The method names

There are many methods, built from a small vocabulary:

| Part of the name | Meaning |
|---|---|
| `Match` | Returns a `bool` |
| `Find` | Returns the leftmost match |
| `FindAll` | Returns all non-overlapping matches (takes a limit `n`; `-1` means all) |
| `Submatch` | Also returns the text of each `(group)` |
| `Index` | Returns byte offsets `[start, end]` instead of text |
| `String` | Works on `string` (without it, on `[]byte`) |
| `Replace`, `Split` | Edit or split the input |

So `FindAllStringSubmatch` returns, for every match, a slice with the whole match first and
then each group. `FindStringSubmatch` returns `nil` when nothing matches, and `FindString`
returns `""`, which is ambiguous when an empty match is possible; test the submatch result for
`nil` (or use `MatchString`) when you need to be sure.

## Named groups and replacing

A group written `(?P<name>...)` (or `(?<name>...)`) has a name. `SubexpNames()` lists the names
by group number (index 0 is the whole match and has no name) and `SubexpIndex(name)` finds the
number for a name.

```go title="b/main.go"
package main

import (
	"fmt"
	"regexp"
)

var logRe = regexp.MustCompile(`^(?P<level>[A-Z]+) (?P<host>[\w.-]+) (?P<status>\d{3})$`)

func main() {
	m := logRe.FindStringSubmatch("WARN example.com 404")
	for i, name := range logRe.SubexpNames() {
		if name != "" {
			fmt.Printf("%d %s=%s\n", i, name, m[i])
		}
	}
	fmt.Println(m[logRe.SubexpIndex("status")])

	fmt.Println(logRe.MatchString("WARN example.com 4040"))

	re := regexp.MustCompile(`(\w+)@(\w+)\.com`)
	in := "alice@example.com, bob@test.com"
	fmt.Println(re.ReplaceAllString(in, "$2:$1"))
	fmt.Println(re.ReplaceAllString(in, "$1_x"))   // $1_x means group named "1_x": empty
	fmt.Println(re.ReplaceAllString(in, "${1}_x")) // braces fix it
	fmt.Println(re.ReplaceAllLiteralString(in, "$1"))
	fmt.Println(re.ReplaceAllStringFunc(in, func(s string) string { return "<" + s + ">" }))

	fmt.Printf("%q\n", regexp.MustCompile(`\s*[,;]\s*`).Split("a , b;c,d", -1))
}
```

```text
1 level=WARN
2 host=example.com
3 status=404
404
false
example:alice, test:bob
, 
alice_x, bob_x
$1, $1
<alice@example.com>, <bob@test.com>
["a" "b" "c" "d"]
```

In replacement text, `$1` or `${1}` inserts group 1 and `${name}` inserts a named group. `$name`
reads as many letters, digits and underscores as it can, so `$1_x` means "the group named
`1_x`", which does not exist and gives empty text. Write `${1}_x`. Use
`ReplaceAllLiteralString` when the replacement must be inserted as it is, with no `$`
expansion, and `ReplaceAllStringFunc` to compute each replacement with code.

Patterns match anywhere in the text unless you anchor them with `^` and `$`. `MatchString` on
an unanchored `\d{3}` is true for `"4040"`; the anchored version is false.

## Syntax reference and the things that fail

| Syntax | Matches |
|---|---|
| `.` | Any character except newline (any, with `(?s)`) |
| `\d \w \s` and `\D \W \S` | Digit, word character (`[0-9A-Za-z_]`), white space, and their negations. ASCII only |
| `\pL`, `\p{Greek}`, `\p{Lu}` | Unicode category or script |
| `[abc] [^abc] [a-z]` | A set, a negated set, a range |
| `^ $` | Start and end of text (of each line with `(?m)`) |
| `\b` | ASCII word boundary |
| `* + ?` | Zero or more, one or more, zero or one (greedy) |
| `*? +? ??` | The same, non-greedy: as few as possible |
| `{n} {n,} {n,m}` | Counted repetition (each count at most 1000) |
| `(...)`, `(?:...)` | Capture group, non-capturing group |
| `a\|b` | Alternation |
| `(?i)` `(?s)` `(?m)` | Flags: ignore case, dot matches newline, multi-line anchors |

The full list is in `go doc regexp/syntax`.

```go title="c/main.go"
package main

import (
	"fmt"
	"regexp"
)

func main() {
	for _, p := range []string{`(a`, `a**`, `(?<=x)y`, `(a)\1`, `[z-a]`, `\p{Foo}`} {
		_, err := regexp.Compile(p)
		fmt.Println(err)
	}

	fmt.Println(regexp.MustCompile(`(?i)go`).MatchString("GO"))
	fmt.Println(regexp.MustCompile(`a.b`).MatchString("a\nb"), regexp.MustCompile(`(?s)a.b`).MatchString("a\nb"))
	fmt.Println(regexp.MustCompile(`(?m)^\w+$`).FindAllString("one\ntwo\nthree four", -1))
	fmt.Println(regexp.MustCompile(`a+?`).FindString("aaa"), regexp.MustCompile(`a+`).FindString("aaa"))
	fmt.Println(regexp.MustCompile(`\p{Greek}+`).FindString("abc αβγ def"))

	user := "a.b*c"
	re := regexp.MustCompile(`^` + regexp.QuoteMeta(user) + `$`)
	fmt.Println(regexp.QuoteMeta(user), re.MatchString("a.b*c"), re.MatchString("aXbbc"))

	ok, err := regexp.MatchString(`^\d+$`, "12345")
	fmt.Println(ok, err)
}
```

```text
error parsing regexp: missing closing ): `(a`
error parsing regexp: invalid nested repetition operator: `**`
error parsing regexp: invalid named capture: `(?<=x)y`
error parsing regexp: invalid escape sequence: `\1`
error parsing regexp: invalid character class range: `z-a`
error parsing regexp: invalid character class range: `\p{Foo}`
true
false true
[one two]
a aaa
αβγ
a\.b\*c true false
true <nil>
```

Unsupported syntax is a compile error with a clear message: unbalanced parentheses, `a**`,
lookbehind (`(?<=x)` reads as a malformed named group), backreferences (`\1`), a reversed
range. Handle these when you call `Compile` with a user's pattern, and show them the message.

`QuoteMeta` escapes all special characters, so text from a user or a file becomes a literal
pattern: always use it when you put non-pattern text into a regular expression. `a.b*c` as a
pattern means something different from the literal string `a.b*c`.

A match is the **leftmost** one; among alternatives that start at the same place the engine
prefers the first alternative, as Perl does. Call `re.Longest()` to switch to leftmost-longest
(POSIX) semantics.

## Cost of compiling

Compiling parses and builds a program, which costs far more than a match. The mistake is to
compile inside the function that uses it:

```go title="d/main.go"
package main

import (
	"fmt"
	"regexp"
	"time"
)

func slow(s string) bool {
	// Compiles on every call.
	return regexp.MustCompile(`^[a-z]+\d{2,4}$`).MatchString(s)
}

var fast = regexp.MustCompile(`^[a-z]+\d{2,4}$`)

func main() {
	const n = 100000
	t := time.Now()
	for range n {
		slow("abcdef123")
	}
	a := time.Since(t)
	t = time.Now()
	for range n {
		fast.MatchString("abcdef123")
	}
	b := time.Since(t)
	fmt.Println("compile every call is slower:", a > 10*b)
	fmt.Printf("ratio is roughly %dx\n", int(a/b)/10*10)
}
```

```text
compile every call is slower: true
ratio is roughly 30x
```

The ratio varies by machine and pattern; it is commonly an order of magnitude or more.

> [!WARNING]
> `regexp.MustCompile` or `regexp.MatchString(pattern, s)` inside a function or loop recompiles
> the pattern on every call (the package-level `regexp.MatchString` compiles each time).
> Symptom: a profile where `regexp/syntax.Parse` and `regexp.compile` dominate, and a request
> handler that is slow only when it uses a pattern ([[pprof-cpu]]). Fix: compile once in a
> package-level `var` and call methods on it.

> [!NOTE]
> Reach for `strings` first. `strings.Contains`, `Cut`, `Fields` and `HasPrefix` are simpler and
> faster for fixed text. Use a regular expression when the text really has a shape (alternatives,
> repetition, optional parts), and do not parse HTML or other nested formats with it: use the
> parser for the format (the capstone uses `golang.org/x/net/html`).

linkcheck compiles its `--include` and `--exclude` patterns once, with `Compile`, because they
come from the command line, in [[step-5-filters]].
