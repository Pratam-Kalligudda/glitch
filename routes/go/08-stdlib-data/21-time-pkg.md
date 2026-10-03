---
title: The time package
done_when: "You format and parse times with a reference-time layout, compute with Duration and AddDate, compare with Equal, and can explain what the zone and monotonic reading of a Time mean."
---
Time is harder than it looks: zones, daylight saving, months of different lengths, clocks that
jump. The `time` package gives you three types to keep these apart.

- **`time.Time`** is an **instant** with a location (time zone) attached for display.
- **`time.Duration`** is a **length of time**, an `int64` count of nanoseconds.
- **`time.Month`** and **`time.Weekday`** are named integers that print as `October` and
  `Saturday`.

## Formatting: the reference time

Go does not use `%Y-%m-%d`. A **layout** is the reference moment
**`Mon Jan 2 15:04:05 MST 2006`** written in the shape you want. Its parts are numbered, which is the
way to remember them: month `1`, day `2`, hour `3` (15 in 24-hour form), minute `4`, second `5`,
year `6`, zone `7` (`-0700`).

```go title="a/main.go"
package main

import (
	"fmt"
	"time"
)

func main() {
	t := time.Date(2026, time.October, 3, 14, 5, 9, 123456789, time.UTC)

	// The layout is the reference time Mon Jan 2 15:04:05 MST 2006,
	// whose parts are numbered 1 2 3 4 5 6 7 (month day hour minute second year zone).
	fmt.Println(t.Format("2006-01-02"))
	fmt.Println(t.Format("2006-01-02 15:04:05"))
	fmt.Println(t.Format("02/01/06 03:04PM"))
	fmt.Println(t.Format("Mon, 2 Jan 2006"))
	fmt.Println(t.Format("Monday January 2"))
	fmt.Println(t.Format("15:04:05.000"))
	fmt.Println(t.Format("15:04:05.999999999"))
	fmt.Println(t.Format(time.RFC3339))
	fmt.Println(t.Format(time.RFC3339Nano))
	fmt.Println(t.Format(time.RFC1123))
	fmt.Println(t.Format(time.DateTime), t.Format(time.DateOnly), t.Format(time.TimeOnly))
	fmt.Println(t.Format(time.Kitchen), t.Format(time.Stamp))
	fmt.Println(t.Format("2006-01-02T15:04:05Z07:00"), t.Format("-0700 MST"))

	// The wrong layout is the classic mistake: it formats without an error.
	fmt.Println(t.Format("YYYY-MM-DD"))
	fmt.Println(t.Format("2006-1-2"), t.Format("2006-Jan-_2"))

	fmt.Println(t)
	fmt.Println(t.Year(), t.Month(), int(t.Month()), t.Day(), t.Weekday(), t.YearDay(), t.Hour(), t.Nanosecond())
	y, w := t.ISOWeek()
	fmt.Println(y, w)
}
```

```bash
go run ./a
```

```text
2026-10-03
2026-10-03 14:05:09
03/10/26 02:05PM
Sat, 3 Oct 2026
Saturday October 3
14:05:09.123
14:05:09.123456789
2026-10-03T14:05:09Z
2026-10-03T14:05:09.123456789Z
Sat, 03 Oct 2026 14:05:09 UTC
2026-10-03 14:05:09 2026-10-03 14:05:09
2:05PM Oct  3 14:05:09
2026-10-03T14:05:09Z +0000 UTC
YYYY-MM-DD
2026-10-3 2026-Oct- 3
2026-10-03 14:05:09.123456789 +0000 UTC
2026 October 10 3 Saturday 276 14 123456789
2026 40
```

| Layout piece | Meaning | Example |
|---|---|---|
| `2006` / `06` | Year | `2026` / `26` |
| `01` / `1` / `Jan` / `January` | Month: zero-padded number, number, abbreviation, name | `10`, `10`, `Oct`, `October` |
| `02` / `2` / `_2` | Day: zero-padded, bare, space-padded | `03`, `3`, ` 3` |
| `15` / `03` / `3` + `PM` | Hour: 24-hour, 12-hour padded, 12-hour bare | `14`, `02`, `2PM` |
| `04` / `4` | Minute | `05` |
| `05` / `5` | Second | `09` |
| `.000` / `.999999999` | Fraction: fixed digits / trailing zeros removed | `.123` / `.123456789` |
| `Mon` / `Monday` | Weekday | `Sat` / `Saturday` |
| `MST` | Zone abbreviation | `UTC`, `IST` |
| `-0700` / `-07:00` / `Z07:00` | Zone offset; `Z07:00` prints `Z` for UTC | `+0530`, `+05:30` |

Use the predefined constants instead of typing a layout where one fits: `time.RFC3339` (for APIs
and JSON), `RFC3339Nano`, `RFC1123` (for HTTP headers: `http.TimeFormat` is the GMT version),
`time.DateTime` (`2006-01-02 15:04:05`), `time.DateOnly`, `time.TimeOnly`, `time.Kitchen`.

> [!WARNING]
> A layout built from the wrong digits does not fail. `Format("YYYY-MM-DD")` returns the literal text
> `YYYY-MM-DD`, and a layout typed as `"2016-01-02"` prints the digits `2016` as fixed text.
> Symptom: dates that are all the same or contain a stray literal. Fix: write the layout from the
> numbered reference, prefer the constants, and write a test with a known date. `go vet` has a check for the
> common `2006-02-01` swap on `Parse` calls.

## Parsing

```go title="b/main.go"
package main

import (
	"fmt"
	"time"
)

func main() {
	t, err := time.Parse("2006-01-02", "2026-10-03")
	fmt.Println(t, err)

	t, err = time.Parse(time.RFC3339, "2026-10-03T14:05:09+05:45")
	fmt.Println(t, err)
	fmt.Println(t.UTC())

	_, err = time.Parse("2006-01-02", "2026-13-03")
	fmt.Println(err)
	_, err = time.Parse("2006-01-02", "03/10/2026")
	fmt.Println(err)
	_, err = time.Parse("2006-01-02", "2026-02-30")
	fmt.Println(err)

	// Parse assumes UTC when the text has no zone; ParseInLocation chooses.
	loc, err := time.LoadLocation("Asia/Kolkata")
	if err != nil {
		fmt.Println(err)
		return
	}
	a, _ := time.Parse("2006-01-02 15:04", "2026-10-03 09:00")
	b, _ := time.ParseInLocation("2006-01-02 15:04", "2026-10-03 09:00", loc)
	fmt.Println(a, b)
	fmt.Println(a.Equal(b), b.Sub(a))
	fmt.Println(b.In(time.UTC))

	var zero time.Time
	fmt.Println(zero, zero.IsZero(), zero.Unix())
}
```

```text
2026-10-03 00:00:00 +0000 UTC <nil>
2026-10-03 14:05:09 +0545 +0545 <nil>
2026-10-03 08:20:09 +0000 UTC
parsing time "2026-13-03": month out of range
parsing time "03/10/2026" as "2006-01-02": cannot parse "03/10/2026" as "2006"
parsing time "2026-02-30": day out of range
2026-10-03 09:00:00 +0000 UTC 2026-10-03 09:00:00 +0530 IST
false -5h30m0s
2026-10-03 03:30:00 +0000 UTC
0001-01-01 00:00:00 +0000 UTC true -62135596800
```

- `time.Parse(layout, text)` parses with the same layout language and returns an error that
  names the problem: `month out of range`, `cannot parse "03/10/2026" as "2006"`. Impossible dates
  such as February 30 are rejected too.
- **The zone is part of the data.** Text without a zone (`2026-10-03 09:00`) is read as **UTC** by
  `Parse`. If the text means local time somewhere, use `ParseInLocation(layout, text, loc)`. In
  the output, `09:00 UTC` and `09:00 IST` are different instants, five and a half hours apart.
- When text has an offset (`+05:45`), `Parse` keeps it. If the offset matches your machine's
  zone, Go uses that zone and its name; otherwise it creates a zone named by the offset (`+0545`).
  That is why the printed zone name can differ from machine to machine; the instant is the same.
- The **zero `Time`** (`time.Time{}`) is January 1, year 1, UTC. `t.IsZero()` tests for it. Use it
  as "not set", never `t == time.Time{}`.
- `time.LoadLocation("Asia/Kolkata")` loads an IANA zone from the system's time zone database. A
  slim container may have none, and then it fails. Add `import _ "time/tzdata"` to embed a copy in
  the binary (about 450 KB), or build with `-tags timetzdata`.

## Duration

```go title="c/main.go"
package main

import (
	"fmt"
	"time"
)

func main() {
	d := 90*time.Minute + 30*time.Second + 500*time.Millisecond
	fmt.Println(d, d.Hours(), d.Minutes(), d.Seconds(), d.Milliseconds())
	fmt.Println(d.Truncate(time.Minute), d.Round(time.Hour))
	fmt.Println(time.Duration(1500)*time.Microsecond, time.Duration(0), 36*time.Hour)

	p, err := time.ParseDuration("1h15m30.5s")
	fmt.Println(p, err)
	_, err = time.ParseDuration("5 minutes")
	fmt.Println(err)
	_, err = time.ParseDuration("90")
	fmt.Println(err)

	// Unit mistake: Duration(n) is n nanoseconds.
	n := 3
	fmt.Println(time.Duration(n), time.Duration(n)*time.Second)
	// float seconds to duration
	secs := 1.5
	fmt.Println(time.Duration(secs * float64(time.Second)))

	start := time.Date(2026, 10, 3, 9, 0, 0, 0, time.UTC)
	end := start.Add(36*time.Hour + 15*time.Minute)
	fmt.Println(end, end.Sub(start), end.After(start), start.Before(end), start.Compare(end))
}
```

```text
1h30m30.5s 1.5084722222222222 90.50833333333334 5430.5 5430500
1h30m0s 2h0m0s
1.5ms 0s 36h0m0s
1h15m30.5s <nil>
time: unknown unit " minutes" in duration "5 minutes"
time: missing unit in duration "90"
3ns 3s
1.5s
2026-10-04 21:15:00 +0000 UTC 36h15m0s true true -1
```

- A `Duration` prints in its most readable form (`1h30m30.5s`) and has `Hours()`, `Minutes()`,
  `Seconds()` (floats) and `Milliseconds()`, `Microseconds()` (integers). `Truncate(m)` rounds
  towards zero to a multiple of `m`, `Round(m)` to the nearest.
- The constants `time.Nanosecond`, `Microsecond`, `Millisecond`, `Second`, `Minute`, `Hour` are
  Durations; you build values by multiplying: `90*time.Minute`. There is no `Day`, because a day is
  not always 24 hours (see below).
- `time.ParseDuration("1h15m30.5s")` accepts the units `ns us ms s m h`. A bare number (`"90"`) or a
  word (`"5 minutes"`) is an error: `missing unit` / `unknown unit`.
- **Multiplying an `int` by a Duration**: `time.Duration(n) * time.Second` is right. `time.Duration(n)` alone is
  `n` **nanoseconds**: `3ns`. And `time.Second * n` fails to compile when `n` is an `int` variable,
  because the types differ: convert the variable.
- `Sub` returns a Duration (`end.Sub(start)`); `Add` shifts a Time by one. Compare with `Before`,
  `After`, `Equal` or `Compare` (Go 1.20, returns -1, 0, 1).

> [!WARNING]
> `time.Sleep(timeout)` where `timeout` is `10` sleeps ten nanoseconds. Symptom: a "10 second" timeout that never
> waits, or a retry loop that spins at full speed. Fix: multiply by a unit, `10 * time.Second`, and for
> values read from config use `time.ParseDuration` or a field of type `time.Duration` in a custom type
> ([[json-custom]]).

## Calendar arithmetic and zones

```go title="d/main.go"
package main

import (
	"fmt"
	"time"
)

func main() {
	t := time.Date(2026, time.January, 31, 12, 0, 0, 0, time.UTC)
	fmt.Println(t.AddDate(0, 1, 0).Format(time.DateOnly)) // Jan 31 + 1 month
	fmt.Println(t.AddDate(0, 0, 30).Format(time.DateOnly))
	fmt.Println(time.Date(2026, 14, 35, 25, 61, 0, 0, time.UTC))
	fmt.Println(t.Truncate(24 * time.Hour).Format(time.DateTime))

	start := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	end := time.Date(2026, 12, 25, 0, 0, 0, 0, time.UTC)
	fmt.Println(int(end.Sub(start).Hours()/24), "days to Dec 25")

	// Start of the month, last day of the month.
	first := time.Date(t.Year(), t.Month(), 1, 0, 0, 0, 0, time.UTC)
	last := first.AddDate(0, 1, -1)
	fmt.Println(first.Format(time.DateOnly), last.Format(time.DateOnly))

	// DST: a "day" is not always 24 hours.
	ny, err := time.LoadLocation("America/New_York")
	if err != nil {
		fmt.Println(err)
		return
	}
	before := time.Date(2026, 3, 7, 12, 0, 0, 0, ny)
	fmt.Println(before.AddDate(0, 0, 1))
	fmt.Println(before.Add(24 * time.Hour))

	// == compares location pointers and monotonic reading; Equal compares instants.
	a := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	b := a.In(ny)
	fmt.Println(a == b, a.Equal(b), a.Compare(b))
}
```

```text
2026-03-03
2026-03-02
2027-03-08 02:01:00 +0000 UTC
2026-01-31 00:00:00
358 days to Dec 25
2026-01-01 2026-01-31
2026-03-08 12:00:00 -0400 EDT
2026-03-08 13:00:00 -0400 EDT
false true 0
```

- **`AddDate(years, months, days)` works on the calendar and normalises overflow.** January 31 plus
  one month is "February 31", which becomes March 3. `time.Date` normalises the same way, which is
  also the trick for "last day of the month": day 0 of next month, or `first.AddDate(0, 1, -1)`.
- **A day is not always 24 hours.** On the day clocks change in a zone with daylight saving time,
  `AddDate(0, 0, 1)` keeps the wall-clock hour (12:00 to 12:00) while `Add(24*time.Hour)` adds exactly
  24 hours of elapsed time (13:00). Use `AddDate` for "same time tomorrow" and `Add` for a fixed
  elapsed interval.
- **`Truncate(24*time.Hour)` cuts at midnight UTC**, not midnight in the Time's zone.
- **Compare instants with `Equal` (or `Compare`), never `==`.** `==` also compares the location and
  the monotonic reading, so the same instant in two zones is not `==`. Do not use `Time` as a map
  key for the same reason; use `t.UnixNano()` or `t.UTC()`.
- Store and transmit times as UTC (RFC 3339, or Unix seconds), and convert to a zone only for display
  with `t.In(loc)`. A `Time` in `encoding/json` is an RFC 3339 string already ([[json]]).

## The clock, timers and tickers

```go title="e/main.go"
package main

import (
	"fmt"
	"time"
)

func main() {
	start := time.Now()
	time.Sleep(50 * time.Millisecond)
	el := time.Since(start)
	fmt.Println(el >= 50*time.Millisecond, el < 500*time.Millisecond)

	// time.Now carries a monotonic clock reading, used by Sub and Since,
	// so they ignore wall-clock jumps. Round(0) strips it.
	fmt.Println(start.Round(0) == start, start.Round(0).Equal(start))
	s := start.String()
	fmt.Println(len(s) > 0, s[len(s)-4:] != "")

	u := time.Unix(1790000000, 0).UTC()
	fmt.Println(u, u.Unix(), u.UnixMilli(), time.UnixMilli(u.UnixMilli()).UTC().Equal(u))

	// Timer: one shot.
	timer := time.NewTimer(30 * time.Millisecond)
	select {
	case <-timer.C:
		fmt.Println("timer fired")
	case <-time.After(time.Second):
		fmt.Println("timeout")
	}

	// Stop before it fires.
	t2 := time.NewTimer(time.Hour)
	fmt.Println("stopped:", t2.Stop())
	// AfterFunc runs a function in its own goroutine.
	done := make(chan struct{})
	time.AfterFunc(10*time.Millisecond, func() { fmt.Println("afterfunc"); close(done) })
	<-done

	// Ticker: repeated.
	tk := time.NewTicker(20 * time.Millisecond)
	defer tk.Stop()
	n := 0
	for range tk.C {
		n++
		if n == 3 {
			break
		}
	}
	fmt.Println("ticks:", n)
}
```

```text
true true
false true
true true
2026-09-21 14:13:20 +0000 UTC 1790000000 1790000000000 true
timer fired
stopped: true
afterfunc
ticks: 3
```

- **Wall clock and monotonic clock.** `time.Now()` returns a Time with both readings. The wall clock
  can jump (NTP adjustments, a user changing the time); the **monotonic** clock only moves forward.
  `Sub`, `Since` and `Until` use the monotonic reading when both times have one, so measuring elapsed time
  with `time.Since(start)` is correct across clock changes. `Round(0)` strips it, as the output shows.
  Times from `Parse`, `Date` or `Unix` have no monotonic reading.
- `time.Unix(sec, nsec)`, `UnixMilli`, `t.Unix()`, `t.UnixMilli()` convert to and from epoch counts.
- **`time.Sleep(d)`** pauses the goroutine. It cannot be cancelled: to wait while still reacting to
  cancellation, `select` on a timer and `ctx.Done()` ([[select]], [[context]]).
- **`time.NewTimer(d)`** sends one value on `timer.C` after `d`; `Stop()` cancels it (and returns whether it
  was still pending), `Reset(d)` rearms it. `time.After(d)` is a timer's channel without the handle, handy in a
  `select`. `time.AfterFunc(d, f)` runs `f` in its own goroutine.
- **`time.NewTicker(d)`** sends repeatedly every `d` on `tk.C`; call `Stop()` when finished.
- Since Go 1.23 timer channels are **unbuffered** and `Stop` and `Reset` guarantee that no stale value is
  received afterwards; unreferenced timers and tickers are garbage collected. Go 1.27 removes the
  `asynctimerchan` setting that could restore the old behaviour, so the new behaviour is the only one.

> [!WARNING]
> A `time.Ticker` or `Timer` you forget to stop keeps running work until it is unreachable. Symptom: a
> long-lived program that slowly leaks timers, or code that still gets ticks after the loop that
> wanted them ended. Fix: `defer tk.Stop()` right after `NewTicker`, and cancel loops through `ctx`.
> Do not poll with `for { time.Sleep(...) }` where a ticker plus `select` fits.

| Task | Code |
|---|---|
| Measure a duration | `start := time.Now(); ...; time.Since(start)` |
| Timestamp for an API or a log | `t.UTC().Format(time.RFC3339)` |
| Parse a date typed by a user | `time.ParseInLocation(layout, text, loc)` |
| Same time tomorrow | `t.AddDate(0, 0, 1)` |
| 24 hours of elapsed time | `t.Add(24 * time.Hour)` |
| Are two times the same instant | `a.Equal(b)` |
| Deadline in a `select` | `time.After(d)`, or better `context.WithTimeout` |
| Run something every second | `time.NewTicker(time.Second)` plus `defer Stop()` |

linkcheck measures each request with `time.Since`, applies its per-request timeout, and spaces
requests with a per-host rate limiter in [[step-4-polite]]; its reports print times in RFC 3339 in
[[step-7-reporters]].
