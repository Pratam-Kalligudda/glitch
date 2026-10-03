---
title: Parsing and resolving URLs
done_when: "You can split a URL into parts, edit its query safely, and resolve a relative link against the page it came from."
---
A URL is a structured value, and the `net/url` package is how you work with its parts instead of slicing strings. Doing it by hand goes wrong in the small details: a space in a path, a `&` inside a query value, a relative link like `../api/`. `url.Parse` turns a string into a `*url.URL`; `String` turns it back, with the right escaping.

A URL has this shape: `scheme://user:password@host:port/path?query#fragment`. `scheme://` is absent in some forms such as `mailto:me@example.com`.

## Taking a URL apart and putting it together

```go title="parse/main.go"
package main

import (
	"fmt"
	"net/url"
)

func main() {
	u, err := url.Parse("https://user:pw@Example.COM:8443/docs/a%20b/index.html?q=go+lang&tag=a&tag=b#install")
	if err != nil {
		panic(err)
	}
	fmt.Println("Scheme:  ", u.Scheme)
	fmt.Println("User:    ", u.User.Username())
	fmt.Println("Host:    ", u.Host)
	fmt.Println("Hostname:", u.Hostname())
	fmt.Println("Port:    ", u.Port())
	fmt.Println("Path:    ", u.Path)
	fmt.Println("RawPath: ", u.RawPath)
	fmt.Println("EscapedPath:", u.EscapedPath())
	fmt.Println("RawQuery:", u.RawQuery)
	fmt.Println("Fragment:", u.Fragment)
	fmt.Println("String:  ", u.String())
	fmt.Println("Redacted:", u.Redacted())

	q := u.Query() // url.Values: map[string][]string
	fmt.Println("q:", q.Get("q"), "| tag:", q["tag"], "| missing:", q.Get("zzz") == "", "| has:", q.Has("tag"))

	q.Set("page", "2")
	q.Add("tag", "c")
	q.Del("q")
	u.RawQuery = q.Encode() // sorted by key, escaped
	u.Fragment = ""
	fmt.Println("rebuilt:", u)

	// Build a URL from parts instead of concatenating strings.
	built := url.URL{
		Scheme:   "https",
		Host:     "example.com",
		Path:     "/search/a b",
		RawQuery: url.Values{"q": {"c++ & go"}}.Encode(),
	}
	fmt.Println("built:  ", built.String())

	fmt.Println(url.QueryEscape("a b/c?d"), url.PathEscape("a b/c?d"))
	s, _ := url.QueryUnescape("a%20b+c")
	fmt.Println(s)
}
```

```bash
go run ./parse
```

```text
Scheme:   https
User:     user
Host:     Example.COM:8443
Hostname: Example.COM
Port:     8443
Path:     /docs/a b/index.html
RawPath:  
EscapedPath: /docs/a%20b/index.html
RawQuery: q=go+lang&tag=a&tag=b
Fragment: install
String:   https://user:pw@Example.COM:8443/docs/a%20b/index.html?q=go+lang&tag=a&tag=b#install
Redacted: https://user:xxxxx@Example.COM:8443/docs/a%20b/index.html?q=go+lang&tag=a&tag=b#install
q: go lang | tag: [a b] | missing: true | has: true
rebuilt: https://user:pw@Example.COM:8443/docs/a%20b/index.html?page=2&tag=a&tag=b&tag=c
built:   https://example.com/search/a%20b?q=c%2B%2B+%26+go
a+b%2Fc%3Fd a%20b%2Fc%3Fd
a b c
```

## How it works

**Decoded and encoded forms live side by side.** `u.Path` holds the path **decoded** (`/docs/a b/index.html`); `u.EscapedPath()` returns the form that goes on the wire (`a%20b`). `RawPath` is filled only when the original encoding differs from the default one, such as `%2F` inside a segment, so it is empty here. Never assign to `Path` expecting the string to appear as typed: `String()` re-encodes it. Read and write `Path`, and let `String` do the escaping.

**The query is kept raw, as a string.** `u.RawQuery` is `q=go+lang&tag=a&tag=b`. `u.Query()` parses it into `url.Values`, a `map[string][]string`, because a key may repeat. `Get` returns the first value or `""` (it cannot tell absent from empty; `Has` can), `Add` appends, `Set` replaces, `Del` removes. `Values` is a copy: after changing it you must assign `u.RawQuery = q.Encode()`. `Encode` sorts by key and escapes, so output is deterministic. `Query` silently drops pairs it cannot parse; use `url.ParseQuery(raw)` when you need the error.

**Host, hostname and port.** `u.Host` includes the port (`Example.COM:8443`). `Hostname()` strips the port and the brackets of an IPv6 address; `Port()` returns it. The host keeps its case; scheme is lowercased (`HTTP://` parses as `http`). Compare hosts case-insensitively.

**Two escape functions, two meanings.** `url.QueryEscape` is for a query value: space becomes `+`, and `/` and `?` are escaped. `url.PathEscape` is for one path segment: space becomes `%20`, `/` is escaped. Using the wrong one produces links that look right and break on a few inputs. Better, avoid both: set fields on a `url.URL` or use `url.Values.Encode`, as `built` does.

**Secrets in URLs.** `String()` prints the password. Use `Redacted()` in logs; it replaces the password with `xxxxx`.

## Resolving relative links

A page's links are usually relative: `install.html`, `../api/`, `/root.html`. To fetch one you need the absolute URL, found by resolving it against the URL of the page that contained it, the **base**. `base.ResolveReference(ref)` follows the rules of RFC 3986, the same ones a browser uses.

```go title="resolve/main.go"
package main

import (
	"fmt"
	"net/url"
)

func main() {
	base, err := url.Parse("https://example.com/docs/guide/index.html?x=1#top")
	if err != nil {
		panic(err)
	}
	for _, ref := range []string{
		"install.html",
		"./install.html",
		"../api/",
		"/root.html",
		"//cdn.example.org/lib.js",
		"https://other.test/x",
		"?page=2",
		"#faq",
		"",
		"mailto:me@example.com",
		"javascript:void(0)",
		"../../../../too-far",
	} {
		r, err := url.Parse(ref)
		if err != nil {
			fmt.Printf("%-26q parse error: %v\n", ref, err)
			continue
		}
		fmt.Printf("%-26q -> %s\n", ref, base.ResolveReference(r))
	}

	joined, _ := url.JoinPath("https://example.com/api/", "/v1/", "links", "a b")
	fmt.Println("JoinPath:", joined)
}
```

```bash
go run ./resolve
```

```text
"install.html"             -> https://example.com/docs/guide/install.html
"./install.html"           -> https://example.com/docs/guide/install.html
"../api/"                  -> https://example.com/docs/api/
"/root.html"               -> https://example.com/root.html
"//cdn.example.org/lib.js" -> https://cdn.example.org/lib.js
"https://other.test/x"     -> https://other.test/x
"?page=2"                  -> https://example.com/docs/guide/index.html?page=2
"#faq"                     -> https://example.com/docs/guide/index.html?x=1#faq
""                         -> https://example.com/docs/guide/index.html?x=1#top
"mailto:me@example.com"    -> mailto:me@example.com
"javascript:void(0)"       -> javascript:void(0)
"../../../../too-far"      -> https://example.com/too-far
JoinPath: https://example.com/api/v1/links/a%20b
```

The rules the output shows:

- A reference without a leading slash replaces the **last segment** of the base path: `install.html` replaces `index.html`, so the directory part is kept. The base's own trailing file name never counts as a directory.
- `..` goes up one directory and `.` stays; going above the root stops at the root.
- A leading `/` replaces the whole path. A leading `//` keeps only the scheme (a scheme-relative link).
- `?page=2` replaces the query and keeps the path; `#faq` keeps path and query and sets the fragment.
- An absolute reference replaces everything, whatever its scheme. `mailto:` and `javascript:` come out unchanged. A crawler must check the scheme itself: only follow `http` and `https`.

`url.JoinPath(base, elem...)` joins path elements with exactly one slash between them and cleans `.` and `..`. Use it to build API URLs from parts. It is not for relative-link resolution; `ResolveReference` is.

## What url.Parse accepts

`url.Parse` is permissive: it accepts many strings that are not usable web URLs, and its answer for them may surprise you.

```go title="pitfalls/main.go"
package main

import (
	"fmt"
	"net/url"
)

func main() {
	for _, s := range []string{
		"example.com/path",
		"//example.com/path",
		"localhost:8080/x",
		"http://example.com:abc/",
		"http://[::1]:8080/",
		"http://::1/",
		"http://exa mple.com/",
		"/just/a/path",
		"http://example.com/%zz",
		"HTTP://Example.com",
	} {
		u, err := url.Parse(s)
		if err != nil {
			fmt.Printf("%-26q error: %v\n", s, err)
			continue
		}
		fmt.Printf("%-26q scheme=%q host=%q path=%q opaque=%q\n", s, u.Scheme, u.Host, u.Path, u.Opaque)
	}

	// Clone (Go 1.27) makes a deep copy: changing the copy leaves the original alone.
	orig, _ := url.Parse("https://example.com/a?x=1")
	cp := orig.Clone()
	cp.Path = "/b"
	q := cp.Query()
	q.Set("x", "2")
	cp.RawQuery = q.Encode()
	fmt.Println(orig, cp)
}
```

```bash
go run ./pitfalls
```

```text
"example.com/path"         scheme="" host="" path="example.com/path" opaque=""
"//example.com/path"       scheme="" host="example.com" path="/path" opaque=""
"localhost:8080/x"         scheme="localhost" host="" path="" opaque="8080/x"
"http://example.com:abc/"  error: parse "http://example.com:abc/": invalid port ":abc" after host
"http://[::1]:8080/"       scheme="http" host="[::1]:8080" path="/" opaque=""
"http://::1/"              error: parse "http://::1/": invalid port "::1" after host
"http://exa mple.com/"     error: parse "http://exa mple.com/": invalid character " " in host name
"/just/a/path"             scheme="" host="" path="/just/a/path" opaque=""
"http://example.com/%zz"   error: parse "http://example.com/%zz": invalid URL escape "%zz"
"HTTP://Example.com"       scheme="http" host="Example.com" path="" opaque=""
```

```text
https://example.com/a?x=1 https://example.com/b?x=2
```

(The last line is the output of the `Clone` part of the same program.)

- **No scheme means no host.** `example.com/path` is a path, not a host. A user who types `example.com` into your flag gets a URL with an empty `Host`, and an HTTP request to it fails with `unsupported protocol scheme ""`.
- **`localhost:8080/x` is not what it looks like.** The text before the first colon looks like a scheme, so `scheme="localhost"` and the rest is `Opaque`. Always include `http://` or `https://`.
- **Go 1.26 tightened colons in hosts.** `http://::1/` is now an error (the IPv6 form needs brackets: `http://[::1]/`). Setting `GODEBUG=urlstrictcolons=0` brings back the old behaviour; do not rely on it.
- **`Parse` does not validate for you.** It does not check that the scheme is `http`, that a host exists, or that the host is a real name. After parsing a URL you will fetch, check `u.Scheme` is `http` or `https` and `u.Host != ""`. `url.ParseRequestURI` is stricter: it requires an absolute URL or an absolute path, and it ignores fragments.
- **`Clone` (Go 1.27)** returns a deep copy of a `*url.URL`, including the `User` value, so changing the copy never changes the original. Before 1.27 `u2 := *u` was the usual copy, which shares the `*Userinfo` pointer. `url.Values` also has a `Clone`.

> [!WARNING]
> Building URLs with string concatenation (`base + "?q=" + term`) breaks on values with `&`, `#`, `+`, `%` or spaces. Symptom: searches for `c++` or `a&b` return the wrong results, and a value containing `#` silently loses everything after it; with user input it also allows a caller to inject extra parameters. Fix: put the value in a `url.Values` and call `Encode`, or set `Path` on a `url.URL` and call `String`.

> [!NOTE]
> Two URLs that mean the same page can differ as text: scheme and host case, `/a/./b` against `/a/b`, a default port (`:443`), a trailing `#fragment`, parameter order. Normalising before comparing is a task of its own; the next thing linkcheck does after resolving a link is to strip the fragment and lowercase the host, so one page is not fetched twice.

linkcheck resolves every link against the page it found it on with `base.Parse`, which calls `ResolveReference`, and filters out `mailto:` and `javascript:` by scheme, in [[step-1-single-page]]. It normalises URLs for its visited set in [[step-2-crawl]], and fuzzes that normaliser in [[step-6-tests]].
