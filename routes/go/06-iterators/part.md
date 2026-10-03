---
title: "Iterators and collections"
goal: Range over anything, and use the slices and maps packages.
---
`for range` is Go's one loop for collections, and since Go 1.22 and 1.23 it also ranges over
integers and over functions. This part covers every form, the loop-variable rule that changed
in Go 1.22, writing your own iterators with the `iter` package, and the `slices` and `maps`
packages built on them.
