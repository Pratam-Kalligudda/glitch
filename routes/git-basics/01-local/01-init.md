---
title: Create a repository
---
A repository is a folder whose history Git records. `git init` creates the hidden `.git` folder that holds that history. Nothing leaves your machine.

```bash
mkdir notes
cd notes
git init -b main
git status
```

`git status` is the command to run whenever you are unsure what state things are in.

> [!NOTE]
> Tell Git who you are once per machine: `git config --global user.name "Your Name"` and `git config --global user.email "you@example.com"`. Every commit records both.
