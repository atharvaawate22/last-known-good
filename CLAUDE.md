# Last Known Good — VS Code Extension

## What this project is

A VS Code extension that automatically snapshots the workspace whenever the code
reaches a "likely good" state (clean compile, passing tests, or the user manually
marks it), and lets the user restore to the most recent working state with one
command. Solves the "it was working 40 minutes ago and I don't know which of my
15 changes broke it" panic moment.

Core philosophy: the extension NEVER claims to know what "working" means.
The user defines the signal. Snapshots are labeled by trigger type so the user
can decide which to trust.

## Architecture (three components, keep them separated)

1. **Signal Detector** (`src/signals/`) — decides WHEN to snapshot.
   - Diagnostics signal: after a document save, debounce 3–5s, then check
     `vscode.languages.getDiagnostics()`. Zero error-severity diagnostics
     across the workspace → fire snapshot with trigger type `compiled`.
   - Task signal: `vscode.tasks.onDidEndTaskProcess`, exit code 0 on a
     user-designated task → trigger type `tests-passed` (or `build-passed`).
   - Manual command: `lastKnownGood.markAsGood` → trigger type `manual`.

2. **Snapshot Engine** (`src/snapshot/`) — does the HOW. **Git plumbing, never
   file copying.**
   - Create: `git stash create` (or equivalent index-tricks to include
     untracked files — see edge cases) → returns a commit hash without
     touching working tree, index, or stash list.
   - Store: `git update-ref refs/lkg/<unix-timestamp>-<trigger> <hash>`
     Shadow refs are invisible in `git log`, `git status`, and all GUIs.
   - Metadata (trigger type, files changed count) goes in the ref name and/or
     a small JSON file in extension globalStorage keyed by hash.
   - Dedupe: skip snapshot if tree hash equals the previous snapshot's tree.
   - Retention: keep last 30 snapshots; thin older ones (hourly for today,
     daily beyond). Delete refs with `git update-ref -d`.

3. **Restore UI** (`src/restore/`) —
   - Command `lastKnownGood.restore`: QuickPick of snapshots showing relative
     time, trigger badge (✓ compiled / ✓✓ tests / ★ manual), and # files
     that differ from current state.
   - **ALWAYS create a safety snapshot of the current (broken) state before
     restoring.** Restore must itself be undoable. Non-negotiable.
   - Restore = `git checkout <hash> -- .` into the working tree (plus
     handling for untracked files present in snapshot).
   - Before applying, show a confirmation listing affected files; offer a
     diff preview via the `vscode.diff` command.
   - Status bar item: "LKG: 4m ago" (time since last snapshot), click →
     restore QuickPick.

## Build order — do NOT skip ahead

### Phase 1 (MVP, manual only — prove the engine before adding cleverness)
1. Scaffold with `yo code` (TypeScript + esbuild bundling).
2. Activate only when workspace root is a git repo; show a friendly one-time
   message otherwise and stay dormant.
3. Implement Snapshot Engine create path + `markAsGood` command.
4. Implement Restore command with pre-restore safety snapshot + confirmation.
5. Status bar item.
Phase 1 has ZERO automatic detection by design.

### Phase 2 (automatic signals)
6. Diagnostics-based auto-snapshot with debounce.
7. Task-success signal with a setting to choose which tasks count.
8. Dedupe + retention policy.

### Phase 3 (trust & polish)
9. Diff preview before restore.
10. Selective (per-file) restore.
11. Sidebar TreeView timeline grouped by day.
12. Settings: enable/disable auto, signal strictness, exclusion globs.

## Edge cases — handle or explicitly defer, never ignore

- **Untracked files**: `git stash create` alone does NOT capture untracked
  files. Test this in Session 1. Approach: use a temporary index
  (`GIT_INDEX_FILE=<tmp> git add -A && git write-tree`, then
  `git commit-tree`) to build a snapshot commit that includes untracked
  files while leaving the real index untouched. "It didn't save my new file"
  destroys user trust instantly.
- Do not snapshot mid-merge/rebase: check for `.git/MERGE_HEAD`,
  `.git/rebase-merge/`, `.git/rebase-apply/`.
- Respect `.gitignore` automatically (git does this for us — never snapshot
  node_modules etc.).
- Multi-root workspaces: v1 handles only the first workspace folder; say so
  in README.
- Large repos: measure snapshot time; run async, never block save; if slow,
  surface a setting to reduce snapshot frequency.
- Restore with dirty working tree: this is the normal case (user's code is
  broken) — safety snapshot covers it, but files that exist now and didn't
  exist in the snapshot should be left alone by default (only overwrite
  tracked-in-snapshot paths) unless user opts into "exact restore".

## Technical conventions

- TypeScript, strict mode. Bundle with esbuild.
- Run git via `child_process.execFile` with argument ARRAYS — never string
  concatenation (breaks on paths with spaces, injection-unsafe).
- All git calls go through one wrapper module (`src/git.ts`) with logging.
- Integration tests for the Snapshot Engine using a temp-dir git repo
  fixture (create repo, write files, snapshot, mutate, restore, assert).
  The engine is the one component where a bug eats someone's work — it is
  the one place tests are mandatory. UI can be tested manually.
- No telemetry in v1.

## Definition of done for Phase 1

From a real project with uncommitted changes: run "Mark as Good", break the
code (edit + create a new untracked file, then mangle both), run "Restore",
pick the snapshot → files return to the marked state, the pre-restore safety
snapshot exists, `git status`/`git log`/`git stash list` look exactly as they
did before the extension ever ran.

## Launch notes (Phase 4)

README needs one GIF above the fold: red squiggles → restore → clean code.
Publish to VS Code Marketplace AND OpenVSX. Companion write-up: "the hard
part wasn't the code, it was defining 'working'" — the trust-model design
story.
