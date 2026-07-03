import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { git } from "../git";
import { SnapshotEngine } from "../snapshot/engine";

const tempDirs: string[] = [];

after(() => {
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
});

async function makeRepo(opts: { initialCommit?: boolean } = {}): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lkg-test-"));
  tempDirs.push(dir);
  await git(dir, ["init", "-b", "main"]);
  await git(dir, ["config", "user.name", "Test"]);
  await git(dir, ["config", "user.email", "test@test.local"]);
  if (opts.initialCommit ?? true) {
    write(dir, "a.txt", "original a\n");
    write(dir, "src/b.txt", "original b\n");
    await git(dir, ["add", "-A"]);
    await git(dir, ["commit", "-m", "initial"]);
  }
  return dir;
}

function write(root: string, rel: string, content: string): void {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

function read(root: string, rel: string): string {
  return fs.readFileSync(path.join(root, rel), "utf8");
}

async function open(dir: string): Promise<SnapshotEngine> {
  const engine = await SnapshotEngine.open(dir);
  assert.ok(engine, "engine should open on a git repo");
  return engine;
}

async function userVisibleState(dir: string): Promise<{
  status: string;
  stash: string;
  log: string;
}> {
  return {
    status: await git(dir, ["status", "--porcelain"]),
    stash: await git(dir, ["stash", "list"]),
    log: await git(dir, ["log", "--oneline"]),
  };
}

describe("SnapshotEngine.open", () => {
  it("returns undefined for a non-repo directory", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lkg-nonrepo-"));
    tempDirs.push(dir);
    assert.equal(await SnapshotEngine.open(dir), undefined);
  });
});

describe("createSnapshot", () => {
  it("captures tracked modifications AND untracked files without touching user-visible state", async () => {
    const dir = await makeRepo();
    const engine = await open(dir);

    write(dir, "a.txt", "modified a\n");
    write(dir, "new-untracked.txt", "brand new\n"); // the trust-destroyer case

    const before = await userVisibleState(dir);
    const result = await engine.createSnapshot("manual");
    const afterState = await userVisibleState(dir);

    assert.equal(result.kind, "created");
    assert.deepEqual(afterState, before, "status/stash/log must be untouched");

    const snap = (result as { kind: "created"; snapshot: { hash: string } }).snapshot;
    const files = await git(dir, ["ls-tree", "-r", "--name-only", snap.hash]);
    assert.ok(files.includes("new-untracked.txt"), "untracked file must be in the snapshot");
    const content = await git(dir, ["show", `${snap.hash}:a.txt`]);
    assert.equal(content, "modified a\n");

    const listed = await engine.list();
    assert.equal(listed.length, 1);
    assert.equal(listed[0].trigger, "manual");
    assert.equal(listed[0].hash, snap.hash);
  });

  it("respects .gitignore", async () => {
    const dir = await makeRepo();
    write(dir, ".gitignore", "node_modules/\n");
    await git(dir, ["add", ".gitignore"]);
    await git(dir, ["commit", "-m", "ignore"]);
    write(dir, "node_modules/pkg/index.js", "junk\n");
    write(dir, "kept.txt", "kept\n");

    const engine = await open(dir);
    const result = await engine.createSnapshot("manual");
    assert.equal(result.kind, "created");
    const snap = (result as { kind: "created"; snapshot: { hash: string } }).snapshot;
    const files = await git(dir, ["ls-tree", "-r", "--name-only", snap.hash]);
    assert.ok(!files.includes("node_modules"), "ignored files must not be snapshotted");
    assert.ok(files.includes("kept.txt"));
  });

  it("dedupes identical states", async () => {
    const dir = await makeRepo();
    const engine = await open(dir);
    write(dir, "a.txt", "v2\n");

    const first = await engine.createSnapshot("manual");
    assert.equal(first.kind, "created");
    const second = await engine.createSnapshot("manual");
    assert.deepEqual(second, { kind: "skipped", reason: "duplicate" });
    assert.equal((await engine.list()).length, 1);
  });

  it("skips while a merge is in progress", async () => {
    const dir = await makeRepo();
    const engine = await open(dir);
    const head = (await git(dir, ["rev-parse", "HEAD"])).trim();
    fs.writeFileSync(path.join(dir, ".git", "MERGE_HEAD"), `${head}\n`);

    const result = await engine.createSnapshot("manual");
    assert.deepEqual(result, { kind: "skipped", reason: "operation-in-progress" });
  });

  it("works in a repo with no commits yet", async () => {
    const dir = await makeRepo({ initialCommit: false });
    const engine = await open(dir);
    write(dir, "first.txt", "hello\n");

    const result = await engine.createSnapshot("manual");
    assert.equal(result.kind, "created");
    const snap = (result as { kind: "created"; snapshot: { hash: string } }).snapshot;

    write(dir, "first.txt", "mangled\n");
    await engine.restoreSnapshot(snap.hash);
    assert.equal(read(dir, "first.txt"), "hello\n");
  });
});

describe("restoreSnapshot (definition-of-done scenario)", () => {
  it("mark good → break code → restore → back to marked state, undoably", async () => {
    const dir = await makeRepo();
    const engine = await open(dir);

    // Uncommitted changes, then Mark as Good.
    write(dir, "a.txt", "good a\n");
    write(dir, "new-file.txt", "good new file\n"); // untracked at mark time
    const preExtensionState = await userVisibleState(dir);
    const marked = await engine.createSnapshot("manual");
    assert.equal(marked.kind, "created");
    const markedHash = (marked as { kind: "created"; snapshot: { hash: string } }).snapshot.hash;

    // Break the code: mangle both files, add an unrelated new file.
    write(dir, "a.txt", "BROKEN a\n");
    write(dir, "new-file.txt", "BROKEN new\n");
    write(dir, "created-after-mark.txt", "should survive restore\n");

    const { safety } = await engine.restoreSnapshot(markedHash);

    // Files return to the marked state.
    assert.equal(read(dir, "a.txt"), "good a\n");
    assert.equal(read(dir, "new-file.txt"), "good new file\n");
    // File that didn't exist in the snapshot is left alone.
    assert.equal(read(dir, "created-after-mark.txt"), "should survive restore\n");

    // The pre-restore safety snapshot holds the broken state.
    assert.equal(safety.trigger, "pre-restore");
    assert.equal(await git(dir, ["show", `${safety.hash}:a.txt`]), "BROKEN a\n");
    assert.equal(await git(dir, ["show", `${safety.hash}:new-file.txt`]), "BROKEN new\n");

    // git stash list and log look exactly as before the extension ran;
    // status differs only by the file the user themselves created after marking.
    const after = await userVisibleState(dir);
    assert.equal(after.stash, preExtensionState.stash);
    assert.equal(after.log, preExtensionState.log);
    const statusDiff = after.status
      .split("\n")
      .filter((l) => l && !preExtensionState.status.split("\n").includes(l));
    assert.deepEqual(statusDiff, ["?? created-after-mark.txt"]);

    // Restore is undoable: applying the safety snapshot brings the broken state back.
    await engine.applySnapshot(safety.hash);
    assert.equal(read(dir, "a.txt"), "BROKEN a\n");
  });

  it("restores files whose parent directories were deleted", async () => {
    const dir = await makeRepo();
    const engine = await open(dir);
    write(dir, "src/b.txt", "good b\n");
    const marked = await engine.createSnapshot("manual");
    assert.equal(marked.kind, "created");
    const hash = (marked as { kind: "created"; snapshot: { hash: string } }).snapshot.hash;

    fs.rmSync(path.join(dir, "src"), { recursive: true, force: true });
    await engine.restoreSnapshot(hash);
    assert.equal(read(dir, "src/b.txt"), "good b\n");
  });
});

describe("diffTrees", () => {
  it("classifies create/overwrite/left-alone correctly", async () => {
    const dir = await makeRepo();
    const engine = await open(dir);

    write(dir, "a.txt", "good\n");
    write(dir, "only-in-snap.txt", "snap\n");
    const marked = await engine.createSnapshot("manual");
    assert.equal(marked.kind, "created");
    const snapTree = await engine.treeOf(
      (marked as { kind: "created"; snapshot: { hash: string } }).snapshot.hash
    );

    write(dir, "a.txt", "broken\n");
    fs.rmSync(path.join(dir, "only-in-snap.txt"));
    write(dir, "only-in-current.txt", "current\n");

    const entries = await engine.diffTrees(await engine.currentTree(), snapTree);
    const byPath = new Map(entries.map((e) => [e.path, e.status]));
    assert.equal(byPath.get("a.txt"), "M"); // will be overwritten
    assert.equal(byPath.get("only-in-snap.txt"), "A"); // will be created
    assert.equal(byPath.get("only-in-current.txt"), "D"); // left alone
  });
});

describe("paths with spaces", () => {
  it("snapshots and restores in a repo path containing spaces", async () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "lkg-test-"));
    tempDirs.push(parent);
    const dir = path.join(parent, "my project");
    fs.mkdirSync(dir);
    await git(dir, ["init", "-b", "main"]);
    await git(dir, ["config", "user.name", "Test"]);
    await git(dir, ["config", "user.email", "test@test.local"]);
    write(dir, "file with space.txt", "good\n");

    const engine = await open(dir);
    const result = await engine.createSnapshot("manual");
    assert.equal(result.kind, "created");
    const hash = (result as { kind: "created"; snapshot: { hash: string } }).snapshot.hash;

    write(dir, "file with space.txt", "broken\n");
    await engine.restoreSnapshot(hash);
    assert.equal(read(dir, "file with space.txt"), "good\n");
  });
});
