---
title: Remotes and push
---
A remote is a copy of the repository somewhere else. By convention the main one is called `origin`. Create an empty repository on GitHub first, then connect and push.

```bash
git remote add origin https://github.com/<user>/<repo>.git
git push -u origin main
```

`-u` links your local `main` to `origin/main`, so later a plain `git push` or `git pull` is enough.

```bash
git pull        # fetch new commits from the remote and merge them
git push        # send your new commits
```

> [!WARNING]
> Do not force-push a branch other people use. It rewrites history they already have.
