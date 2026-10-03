---
title: "Errors"
goal: Make failures explicit, inspectable and well designed.
---
In Go a failure is an ordinary value of the `error` interface, returned and checked like
any other result. This part covers how to add context by wrapping, how callers inspect
wrapped errors with `errors.Is`, `errors.As` and `errors.AsType`, how `defer`, `panic` and
`recover` fit in, and how to design the errors a package exposes so callers can act on
them.
