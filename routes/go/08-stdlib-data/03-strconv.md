---
title: strconv
done_when: "You convert text to numbers and booleans with an explicit base and size, check the error, and recognise a *strconv.NumError."
---
`strconv` converts between strings and basic types: integers, floats, booleans and quoted
strings. Everything you read from outside the program (a flag, an environment variable, a
config file, a URL query) arrives as text, so these conversions are the border between
the outside world and your typed values. The rules are strict on purpose: a string that is
not exactly a number is an error, never a guess.

## Integers

```go title="a/main.go"
package main

import (
	"fmt"
	"strconv"
)

func main() {
	n, err := strconv.Atoi("42")
	fmt.Println(n, err)

	for _, in := range []string{"", " 42", "+7", "4_2", "0x1f", "3.0", "99999999999999999999"} {
		n, err := strconv.Atoi(in)
		fmt.Printf("Atoi(%q) = %d, %v\n", in, n, err)
	}

	fmt.Println(strconv.Itoa(-45), strconv.FormatInt(255, 2), strconv.FormatInt(255, 16), strconv.FormatInt(-255, 36))
}
```

```bash
go run ./a
```

```text
42 <nil>
Atoi("") = 0, strconv.Atoi: parsing "": invalid syntax
Atoi(" 42") = 0, strconv.Atoi: parsing " 42": invalid syntax
Atoi("+7") = 7, <nil>
Atoi("4_2") = 0, strconv.Atoi: parsing "4_2": invalid syntax
Atoi("0x1f") = 0, strconv.Atoi: parsing "0x1f": invalid syntax
Atoi("3.0") = 0, strconv.Atoi: parsing "3.0": invalid syntax
Atoi("99999999999999999999") = 9223372036854775807, strconv.Atoi: parsing "99999999999999999999": value out of range
-45 11111111 ff -73
```

`Atoi` ("ASCII to integer") is `ParseInt(s, 10, 0)` that returns an `int`. It accepts an
optional sign and decimal digits, and nothing else: no spaces, no `4_2`, no `0x1f`, no
decimal point. It returns `0` and an error for anything it cannot read. On overflow it
returns the nearest limit (`9223372036854775807` above) **and** an error, so always check
the error before using the number.

`Itoa` is the reverse. `FormatInt(n, base)` writes in any base from 2 to 36 with lower-case
letters.

### ParseInt: base and bit size

```go title="b/main.go"
package main

import (
	"errors"
	"fmt"
	"strconv"
)

func main() {
	v, err := strconv.ParseInt("300", 10, 8) // does it fit in int8?
	fmt.Println(v, err)

	v, err = strconv.ParseInt("ff", 16, 64)
	fmt.Println(v, err)
	v, err = strconv.ParseInt("0xff", 0, 64) // base 0: prefix decides
	fmt.Println(v, err)
	v, err = strconv.ParseInt("0b101", 0, 64)
	fmt.Println(v, err)
	v, err = strconv.ParseInt("1_000", 0, 64) // underscores only with base 0
	fmt.Println(v, err)
	v, err = strconv.ParseInt("1_000", 10, 64)
	fmt.Println(v, err)

	u, err := strconv.ParseUint("-1", 10, 64)
	fmt.Println(u, err)

	_, err = strconv.Atoi("12a")
	var ne *strconv.NumError
	if errors.As(err, &ne) {
		fmt.Printf("Func=%q Num=%q Err=%v\n", ne.Func, ne.Num, ne.Err)
	}
	fmt.Println(errors.Is(err, strconv.ErrSyntax), errors.Is(err, strconv.ErrRange))
	_, err = strconv.ParseInt("999999999999999999999", 10, 64)
	fmt.Println(errors.Is(err, strconv.ErrRange), err)
}
```

```text
127 strconv.ParseInt: parsing "300": value out of range
255 <nil>
255 <nil>
5 <nil>
1000 <nil>
0 strconv.ParseInt: parsing "1_000": invalid syntax
0 strconv.ParseUint: parsing "-1": invalid syntax
Func="Atoi" Num="12a" Err=invalid syntax
true false
true strconv.ParseInt: parsing "999999999999999999999": value out of range
```

`ParseInt(s, base, bitSize)` has two knobs.

- **`base`** is 2 to 36. Base `0` means "decide from the prefix": `0x` hex, `0b` binary,
  `0o` or a leading `0` octal, otherwise decimal. Base 0 is also the only one that accepts
  underscores between digits (`1_000`), as Go source does.
- **`bitSize`** is the size the result must fit in: 8, 16, 32 or 64, with `0` meaning
  `int`. The return type is always `int64`; `bitSize` only decides whether the value is in
  range. `ParseInt("300", 10, 8)` returns `127`, the largest `int8`, with a range error.
  Convert the result to your narrower type yourself (`int8(v)`) after the check.

`ParseUint` is the unsigned version and rejects a sign: `ParseUint("-1", ...)` is a syntax
error, not a wrap-around.

### The error

Every failure is a `*strconv.NumError` with three fields: `Func` (the function name), `Num`
(the input) and `Err` (the cause). The cause is one of two sentinel errors:

| `Err` | Meaning |
|---|---|
| `strconv.ErrSyntax` | The input is not a valid number for that base or type |
| `strconv.ErrRange` | The input is valid but does not fit the requested size |

`NumError` implements `Unwrap`, so `errors.Is(err, strconv.ErrRange)` works through
wrapping ([[is-as]]). Telling the two apart lets you give a useful message: "not a
number" versus "too large".

## Floats and booleans

```go title="c/main.go"
package main

import (
	"fmt"
	"math"
	"strconv"
)

func main() {
	f, err := strconv.ParseFloat("3.14159", 64)
	fmt.Println(f, err)
	for _, in := range []string{"1e3", "inf", "-Inf", "NaN", "1,5", ".5", "0x1p-2", "1e999"} {
		f, err := strconv.ParseFloat(in, 64)
		fmt.Printf("ParseFloat(%q) = %v, %v\n", in, f, err)
	}
	fmt.Println(strconv.FormatFloat(1234.5678, 'f', 2, 64))
	fmt.Println(strconv.FormatFloat(1234.5678, 'e', -1, 64))
	fmt.Println(strconv.FormatFloat(1234.5678, 'g', -1, 64))
	fmt.Println(strconv.FormatFloat(0.1, 'f', -1, 32), strconv.FormatFloat(float64(float32(0.1)), 'f', -1, 64))
	fmt.Println(strconv.FormatFloat(math.Pi, 'f', 3, 64))

	for _, in := range []string{"true", "T", "1", "FALSE", "f", "yes", "True", "tRUE"} {
		b, err := strconv.ParseBool(in)
		fmt.Printf("ParseBool(%q) = %v, %v\n", in, b, err)
	}
	fmt.Println(strconv.FormatBool(false))
}
```

```text
3.14159 <nil>
ParseFloat("1e3") = 1000, <nil>
ParseFloat("inf") = +Inf, <nil>
ParseFloat("-Inf") = -Inf, <nil>
ParseFloat("NaN") = NaN, <nil>
ParseFloat("1,5") = 0, strconv.ParseFloat: parsing "1,5": invalid syntax
ParseFloat(".5") = 0.5, <nil>
ParseFloat("0x1p-2") = 0.25, <nil>
ParseFloat("1e999") = +Inf, strconv.ParseFloat: parsing "1e999": value out of range
1234.57
1.2345678e+03
1234.5678
0.1 0.10000000149011612
3.142
ParseBool("true") = true, <nil>
ParseBool("T") = true, <nil>
ParseBool("1") = true, <nil>
ParseBool("FALSE") = false, <nil>
ParseBool("f") = false, <nil>
ParseBool("yes") = false, strconv.ParseBool: parsing "yes": invalid syntax
ParseBool("True") = true, <nil>
ParseBool("tRUE") = false, strconv.ParseBool: parsing "tRUE": invalid syntax
false
```

`ParseFloat(s, 64)` accepts decimal and exponent forms (`1e3`), `inf`, `-Inf` and `NaN`
(any case), and hex floats (`0x1p-2`). It does not accept a decimal comma: `1,5` is a
syntax error, so localise input yourself before parsing. A value too large for the type
returns `±Inf` and `ErrRange`. With `bitSize` 32 the result is rounded to the nearest
`float32` but is still returned as `float64`.

`FormatFloat(f, fmt, prec, bitSize)` takes a format byte (`'f'` plain, `'e'` exponent, `'g'`
compact), a precision, and the bit size of the float it came from. Precision `-1` means "the
fewest digits that read back as exactly this value", which is what `fmt` uses for `%v`.
The bit size matters: `0.1` printed as a `float32` is `0.1`, but a `float32` converted to
`float64` is really `0.10000000149011612`.

`ParseBool` accepts exactly `1`, `t`, `T`, `TRUE`, `true`, `True`, `0`, `f`, `F`, `FALSE`,
`false` and `False`. `yes` and `tRUE` are errors. If your input uses other words, map them
yourself.

## Quoting and appending

```go title="d/main.go"
package main

import (
	"fmt"
	"strconv"
)

func main() {
	q := strconv.Quote("tab\there \"quoted\" é   \x00")
	fmt.Println(q)
	fmt.Println(strconv.QuoteToASCII("héllo 世界"))
	fmt.Println(strconv.QuoteRune('☺'))

	s, err := strconv.Unquote(`"a\tb"`)
	fmt.Printf("%q %v\n", s, err)
	s, err = strconv.Unquote("`raw\n`")
	fmt.Printf("%q %v\n", s, err)
	_, err = strconv.Unquote("no quotes")
	fmt.Println(err)

	buf := []byte("n=")
	buf = strconv.AppendInt(buf, 42, 10)
	buf = append(buf, ' ')
	buf = strconv.AppendQuote(buf, "x")
	fmt.Println(string(buf))

	fmt.Println(string(rune(65)), strconv.Itoa(65))
}
```

```text
"tab\there \"quoted\" é \u2028 \x00"
"h\u00e9llo \u4e16\u754c"
'☺'
"a\tb" <nil>
"raw\n" <nil>
invalid syntax
n=42 "x"
A 65
```

`Quote` is what `%q` uses: a Go string literal with escapes for control characters and
invalid UTF-8. `QuoteToASCII` escapes every non-ASCII character too. `Unquote` reverses it
and accepts double-quoted, back-quoted (raw) and single-quoted forms; text without quotes
is `invalid syntax`.

The `Append` functions (`AppendInt`, `AppendQuote`, `AppendFloat`, `AppendBool`) add the
text straight onto a `[]byte`. They avoid the temporary string that `Itoa` creates, which
matters in a hot loop that builds output ([[pools-builders]]).

> [!WARNING]
> `string(65)` is `"A"`, not `"65"`: converting an integer to a string yields the character
> with that code point. Symptom: a response that contains letters or `\x00` where you
> expected digits. `go vet` reports "conversion from int to string yields a string of one
> rune, not a string of digits". Fix: `strconv.Itoa(65)` (or `fmt.Sprint(65)`) for digits, and write
> `string(rune(65))` when you do want the character.

> [!WARNING]
> Ignoring the error (`n, _ := strconv.Atoi(s)`) turns bad input into `0`, which is often a
> valid value. Symptom: a typo in a flag or config value silently becomes zero (port 0,
> zero retries, depth 0). Fix: handle the error and include the bad input in the message;
> the `NumError` text already does: `strconv.Atoi: parsing "12a": invalid syntax`.

linkcheck parses the count in its `--rate` value with `strconv.Atoi` in [[step-4-polite]],
and formats numbers for its CSV report with `strconv` in [[step-7-reporters]].
