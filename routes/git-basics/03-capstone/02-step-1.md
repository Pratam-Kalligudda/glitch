---
title: "Step 1: put it online"
done_when: "`git status` says your branch is up to date with `origin/main`, and the files are visible on GitHub."
---
Do this yourself first, then compare with the commands below.

1. Create the repository as in [[init]].
2. Add a `.gitignore` before the first commit, so unwanted files never enter the history.
3. Make at least three commits, staging deliberately as in [[commit]].
4. Create an empty repository on GitHub, then connect and push as in [[remote]].

One possible run:

```bash
git init -b main
printf "node_modules/\n.env\n" > .gitignore
git add .gitignore
git commit -m "Add gitignore"
git add .
git commit -m "Add project files"
git remote add origin https://github.com/<user>/<repo>.git
git push -u origin main
```
