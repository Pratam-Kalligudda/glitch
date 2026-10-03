---
title: "Concurrency"
goal: Write concurrent code that is correct, bounded and cancellable.
---
Go makes starting concurrent work easy; getting it right is your job. This part builds
the toolkit from the bottom up: goroutines, channels and `select`, the `sync` primitives
and the memory model that explains why they work, then `context` for cancellation, and
the patterns (pipelines, worker pools, errgroup, rate limits) the capstone's crawler is
made of. It ends with finding goroutines that never finish.
