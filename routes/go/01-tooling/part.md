---
title: "Tooling and modules"
goal: Build, version and ship Go code with the go command.
---
Before the language, the tool. Every Go project is built, versioned, checked and shipped with
the `go` command, and most "works on my machine" problems in Go come from not knowing what it
decides for you: which toolchain runs, which dependency versions are chosen, which files are
compiled. This part makes those decisions visible, so the rest of the route builds on a module
you fully control.
