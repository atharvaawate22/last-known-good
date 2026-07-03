---
name: verify
description: How to verify Last Known Good (VS Code extension) end-to-end by driving a real VS Code instance.
---

# Verifying Last Known Good

The surface is a VS Code extension. Unit tests (`npm test`) cover the git
engine only — real verification drives the extension inside a real VS Code
instance via `@vscode/test-electron`.

## Command

```
npm run e2e
```

This bundles (esbuild), compiles (tsc), then runs `out/test/e2e/runE2E.js`,
which launches VS Code twice (a window appears briefly on screen):

1. **Git workspace** (`src/test/e2e/suite.ts`): scratch repo with a base
   commit, `.vscode/settings.json` (debounce 1s, `testTasks: ["smoke"]`) and a
   `smoke` echo task. Drives: `markAsGood` (untracked file captured, dedupe),
   diagnostics auto-snapshot via a real editor save, task signal via
   `tasks.executeTask`, restore QuickPick open/cancel at both steps, and
   asserts `git log` / `stash list` / index are untouched.
2. **Non-repo workspace** (`suiteNoRepo.ts`): asserts the extension stays
   dormant (no commands registered).

## Gotchas

- **Must strip `ELECTRON_RUN_AS_NODE`** before `runTests` (done in
  `runE2E.ts`) — it leaks from VS Code's terminal and makes the spawned
  Electron treat the workspace path as a JS module.
- First run downloads ~280 MB of VS Code into `.vscode-test/` (gitignored);
  later runs reuse it.
- The restore **confirmation modal cannot be driven programmatically** — the
  apply-restore path is covered by engine integration tests
  (`src/test/engine.test.ts`, definition-of-done scenario) plus manual F5.
  QuickPick steps ARE drivable: `workbench.action.quickOpenSelectNext`,
  `workbench.action.acceptSelectedQuickOpenItem`,
  `workbench.action.closeQuickOpen`.
- Timeline TreeView and status bar text are not readable through the API;
  check them manually in the Extension Development Host (F5).
