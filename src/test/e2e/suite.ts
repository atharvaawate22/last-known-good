import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { git } from "../../git";

const log = (m: string) => console.log(`[e2e] ${m}`);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Ref {
  ref: string;
  hash: string;
  trigger: string;
}

async function refs(root: string): Promise<Ref[]> {
  const out = await git(root, [
    "for-each-ref",
    "--format=%(refname)%09%(objectname)",
    "refs/lkg",
  ]);
  return out
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [ref, hash] = line.split("\t");
      const m = /^refs\/lkg\/\d+-(.+)$/.exec(ref);
      return { ref, hash, trigger: m ? m[1] : "?" };
    });
}

async function until<T>(
  what: string,
  fn: () => Promise<T | undefined>,
  timeoutMs = 20_000
): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v !== undefined) {
      return v;
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error(`timeout waiting for ${what}`);
    }
    await wait(250);
  }
}

export async function run(): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(folder, "workspace folder missing");
  const root = folder.uri.fsPath;

  const ext = vscode.extensions.getExtension("atharvaawate.last-known-good");
  assert.ok(ext, "extension not found in test host");
  await ext.activate();
  log("extension activated");

  const before = {
    log: await git(root, ["log", "--oneline"]),
    stash: await git(root, ["stash", "list"]),
    staged: await git(root, ["diff", "--cached", "--name-only"]),
  };

  // 1. Mark as Good with a tracked modification AND a brand-new untracked file.
  fs.writeFileSync(path.join(root, "base.txt"), "good version\n");
  fs.writeFileSync(path.join(root, "untracked.txt"), "new good file\n");
  await vscode.commands.executeCommand("lastKnownGood.markAsGood");
  let all = await refs(root);
  const manual = all.filter((r) => r.trigger === "manual");
  assert.equal(manual.length, 1, `expected 1 manual ref, got ${JSON.stringify(all)}`);
  assert.equal(
    await git(root, ["show", `${manual[0].hash}:untracked.txt`]),
    "new good file\n",
    "untracked file must be inside the snapshot"
  );
  log("markAsGood created a manual snapshot including the untracked file");

  // 2. Mark as Good again with no changes — dedupe must skip.
  await vscode.commands.executeCommand("lastKnownGood.markAsGood");
  all = await refs(root);
  assert.equal(
    all.filter((r) => r.trigger === "manual").length,
    1,
    "dedupe failed: second identical markAsGood created a new ref"
  );
  log("dedupe: identical second markAsGood created no new ref");

  // 3. Diagnostics auto-snapshot: edit + save through the real editor,
  //    debounce is 1s in this workspace's settings.
  const doc = await vscode.workspace.openTextDocument(path.join(root, "base.txt"));
  const editor = await vscode.window.showTextDocument(doc);
  await editor.edit((eb) => eb.insert(new vscode.Position(0, 0), "auto trigger edit\n"));
  await doc.save();
  await until("compiled auto-snapshot after save", async () =>
    (await refs(root)).find((r) => r.trigger === "compiled")
  );
  log("diagnostics signal: save with clean diagnostics auto-snapshotted (compiled)");

  // 4. Task signal: run the designated "smoke" task, expect tests-passed.
  fs.writeFileSync(path.join(root, "base.txt"), "task trigger version\n");
  const tasks = await vscode.tasks.fetchTasks();
  const smoke = tasks.find((t) => t.name === "smoke");
  assert.ok(smoke, `smoke task not found; saw: ${tasks.map((t) => t.name).join(", ")}`);
  await vscode.tasks.executeTask(smoke);
  await until("tests-passed snapshot after smoke task", async () =>
    (await refs(root)).find((r) => r.trigger === "tests-passed")
  );
  log("task signal: designated task exit 0 auto-snapshotted (tests-passed)");

  // 5. Restore command: open the snapshot picker, then cancel — nothing may change.
  const stateBefore = fs.readFileSync(path.join(root, "base.txt"), "utf8");
  const refsBefore = (await refs(root)).length;
  const restore1 = vscode.commands.executeCommand("lastKnownGood.restore");
  await wait(2000);
  await vscode.commands.executeCommand("workbench.action.closeQuickOpen");
  await restore1;
  assert.equal(fs.readFileSync(path.join(root, "base.txt"), "utf8"), stateBefore);
  assert.equal((await refs(root)).length, refsBefore, "cancelled restore must not snapshot");
  log("restore: cancelling the snapshot picker changes nothing");

  // 6. Restore command: pick an older snapshot (arrow down past the identical
  //    newest one), reach the per-file checklist, then cancel it.
  const restore2 = vscode.commands.executeCommand("lastKnownGood.restore");
  await wait(2000);
  await vscode.commands.executeCommand("workbench.action.quickOpenSelectNext");
  await vscode.commands.executeCommand("workbench.action.acceptSelectedQuickOpenItem");
  await wait(2000); // per-file checklist appears
  await vscode.commands.executeCommand("workbench.action.closeQuickOpen");
  await restore2;
  assert.equal(fs.readFileSync(path.join(root, "base.txt"), "utf8"), stateBefore);
  assert.equal((await refs(root)).length, refsBefore, "cancelled checklist must not snapshot");
  log("restore: cancelling the per-file checklist changes nothing");

  // 7. Invariants: visible git state untouched by everything above.
  assert.equal(await git(root, ["log", "--oneline"]), before.log, "git log changed");
  assert.equal(await git(root, ["stash", "list"]), before.stash, "stash list changed");
  assert.equal(
    await git(root, ["diff", "--cached", "--name-only"]),
    before.staged,
    "index (staged files) changed"
  );
  log("invariants hold: log, stash, and index are exactly as before");
}
