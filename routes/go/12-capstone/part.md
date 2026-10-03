---
title: "Capstone: linkcheck"
goal: Build a concurrent link checker, test it, tune it and ship it as a single binary.
kind: capstone
---
This part builds one real tool, a concurrent link checker called `linkcheck`, in ten steps that each add to the same code. Every part of the route reappears here: the types, interfaces and errors shape its design, generics and iterators shape its reports, concurrency makes it fast and polite, the standard library gives it its formats and its network code, and the testing and performance parts prove it works and measure what it costs. It ends as a versioned binary you can run against your own sites.
