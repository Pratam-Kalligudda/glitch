---
title: "Performance and the runtime"
goal: Measure first, then make Go programs faster and leaner.
---
Performance work starts with measurement, not guessing. This part shows how Go decides where values live, how to profile CPU, memory and scheduling, how to tune the garbage collector, and how to feed a profile back into the compiler. linkcheck gets profiled and tuned in [[step-9-profile]].
