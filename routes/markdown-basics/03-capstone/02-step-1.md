---
title: "Step 1: draft the README"
done_when: The file has a title, summary, install and usage sections, a list and a table, and renders without stray symbols in your editor's preview.
---
Write `README.md` in the root of the project.

1. Start with a heading and summary as in [[headings]].
2. Add an install section with a code block as in [[code-blocks]].
3. Add a usage section with a table of commands as in [[tables-images]].
4. List what the project can do, as in [[lists]].

One possible README:

````markdown
# Notes

A small app for keeping notes in the terminal.

## Install

```bash
git clone https://github.com/<user>/notes.git
cd notes
npm install
```

## Usage

| Command | Does |
|---|---|
| `npm start` | Open the notes |
| `npm test` | Run the tests |

## Features

- Write and tag notes
- Search by tag
````
