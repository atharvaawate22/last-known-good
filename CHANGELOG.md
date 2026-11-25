# Changelog

## 0.1.1

Restore fixes.

- A full restore no longer deletes files that were committed or staged after
  the snapshot. Restore now writes only the files that exist in the snapshot
  and differ from the current state, as the confirm dialog always said.
- A partial restore no longer overwrites files you unchecked when a selected
  file name contains glob characters, e.g. Next.js routes like `app/[id]/page.tsx`.
  Paths are now matched literally.
- Large partial restores no longer risk hitting the Windows command-line
  length limit.

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
