---
title: Read history
---
Three commands answer most questions about what happened.

```bash
git log --oneline        # one line per commit, newest first
git diff                 # changes you have not staged yet
git diff --staged        # changes staged for the next commit
git show <hash>          # one commit in full
```

Each commit has a hash such as `4a6b16f`. The first seven characters are enough to name it.
