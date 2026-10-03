---
title: "Testing"
goal: Test behaviour, concurrency and edge cases with go test.
---
Go ships its test tooling in the standard library and the go command. This part starts with table-driven tests and the helpers around them, replaces the network with fakes and httptest, then covers the tools for the hard cases: golden files, testing/synctest for time and goroutines, fuzzing, benchmarks, coverage and the race detector. It ends with examples that double as documentation. linkcheck uses all of it in [[step-6-tests]].
