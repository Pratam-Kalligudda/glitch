---
title: Tables and images
---
A table is rows of cells separated by `|`. The second row of dashes separates the header. An image is a link with `!` in front; the text in square brackets is the alternative text for screen readers.

```markdown
| Command | Does |
|---|---|
| `npm start` | Start the app |
| `npm test` | Run the tests |

![Layout of a README](docs/readme-layout.svg)
```

A README usually follows the same order every time:

![Layout of a README: title, summary, install, usage, licence](readme-layout.svg)

> [!WARNING]
> Image paths are relative to the Markdown file. A path that works on your machine but points outside the repository shows a broken image on GitHub.
