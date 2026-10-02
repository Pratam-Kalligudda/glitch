---
title: Stage and commit
---
A commit is a snapshot of the files you chose. Choosing is called staging: `git add` puts changes in the staging area, and `git commit` records exactly what is staged.

```bash
echo "# Notes" > README.md
git add README.md
git commit -m "Add README"
```

Staging lets one commit hold one idea even when you changed several things. Use `git add .` to stage everything in the current folder.

| Command | Does |
|---|---|
| `git add <file>` | Stage one file |
| `git add .` | Stage every change under the current folder |
| `git restore --staged <file>` | Unstage, keeping your edits |
| `git commit -m "message"` | Record what is staged |
