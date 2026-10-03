---
title: "Interfaces"
goal: Design small interfaces and compose behaviour from them.
---
Interfaces are how Go code depends on behaviour instead of on concrete types, and they are
satisfied implicitly, so the consumer declares exactly the methods it needs. This part
covers what an interface value is at run time, how to get concrete types back out, how
small interfaces such as `io.Reader` and `io.Writer` compose, and the API rules that make
code easy to test. The `error` interface in the next part and the fakes in the testing
part both build on it.
