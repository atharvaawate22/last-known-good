# Changelog

## 0.1.0

Initial release.

- **Mark as Good** command: manual snapshots of the entire working state —
  tracked changes *and* untracked files, `.gitignore` respected.
- Automatic snapshots when the workspace has zero error diagnostics after a
  save (configurable debounce and strictness), and when designated tasks exit
  successfully (`lastKnownGood.testTasks` / `lastKnownGood.buildTasks`).
- **Restore…** command: pick a snapshot, preview per-file diffs, restore all
  or only selected files. A safety snapshot of the current state is always
  taken first, so every restore is undoable.
- Timeline view in the Explorer sidebar, grouped by day; status bar shows
  time since the last snapshot.
- Snapshots are hidden git refs (`refs/lkg/*`): invisible in `git log`,
  `git status`, `git stash list`, and GUIs; the index and stash are never
  touched. Dedupe by tree hash; retention thins old snapshots (hourly for
  today, daily beyond, max 30).
- No telemetry.
