---
title: "Standard library: text, files and data"
goal: Process text, files and every common data format with the standard library.
---
Most programs spend their time turning text and bytes into something else. This part covers
formatting and parsing text (`fmt`, `strings`, `strconv`, `regexp`), reading and writing files, and
the data formats Go ships with (JSON, CSV, XML, base64, binary, gob, compression), then hashing,
randomness, templates and time. Each stop shows the package with runnable code and the mistakes
that go with it, and several are used directly by the capstone's reporters and saved state.
