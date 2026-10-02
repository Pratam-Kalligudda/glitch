---
title: Branches
---
A branch is a movable name for a line of commits. Work on a branch so that `main` always holds something that works.

```bash
git switch -c add-license      # create a branch and move to it
echo "MIT" > LICENSE
git add LICENSE
git commit -m "Add license"
git switch main
git merge add-license
git branch -d add-license      # delete the merged branch
```

Commits on the branch are made exactly as in [[commit]]. Merging brings them into `main`.
