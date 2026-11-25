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

async function makeRepo(): Promise<{ dir: string; engine: SnapshotEngine }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lkg-p3-"));
  tempDirs.push(dir);
  await git(dir, ["init", "-b", "main"]);
  await git(dir, ["config", "user.name", "Test"]);
  await git(dir, ["config", "user.email", "test@test.local"]);
  const engine = await SnapshotEngine.open(dir);
  assert.ok(engine, "engine should open on a fresh repo");
  return { dir, engine };
}

function write(dir: string, rel: string, content: string): void {
  const full = path.join(dir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

async function snapshotHash(engine: SnapshotEngine): Promise<string> {
  const result = await engine.createSnapshot("manual");
  assert.equal(result.kind, "created");
  if (result.kind !== "created") {
    throw new Error("unreachable");
  }
  return result.snapshot.hash;
}

describe("selective restore", () => {
  it("restores only the chosen paths and leaves the rest broken", async () => {
    const { dir, engine } = await makeRepo();
    write(dir, "one.txt", "one good\n");
    write(dir, "two.txt", "two good\n");
    write(dir, "sub/three.txt", "three good\n");
    const hash = await snapshotHash(engine);

    write(dir, "one.txt", "one BROKEN\n");
    write(dir, "two.txt", "two BROKEN\n");
    write(dir, "sub/three.txt", "three BROKEN\n");

    await engine.restoreSnapshot(hash, ["one.txt", "sub/three.txt"]);

    assert.equal(fs.readFileSync(path.join(dir, "one.txt"), "utf8"), "one good\n");
    assert.equal(fs.readFileSync(path.join(dir, "two.txt"), "utf8"), "two BROKEN\n");
    assert.equal(
      fs.readFileSync(path.join(dir, "sub", "three.txt"), "utf8"),
      "three good\n"
    );

    // The safety snapshot still captures ALL of the pre-restore state,
    // including the file we chose not to restore.
    const snapshots = await engine.list();
    const safety = snapshots.find((s) => s.trigger === "pre-restore");
    assert.ok(safety, "safety snapshot must exist");
    assert.equal(
      await engine.fileAtSnapshot(safety.hash, "two.txt"),
      "two BROKEN\n"
    );
  });
});

describe("restore leaves files outside the snapshot alone", () => {
  it("full restore keeps files committed or staged after the snapshot", async () => {
    const { dir, engine } = await makeRepo();
    write(dir, "a.txt", "a good\n");
    await git(dir, ["add", "-A"]);
    await git(dir, ["commit", "-m", "base"]);
    const hash = await snapshotHash(engine);

    write(dir, "a.txt", "a BROKEN\n");
    write(dir, "committed-later.txt", "committed after snapshot\n");
    await git(dir, ["add", "committed-later.txt"]);
    await git(dir, ["commit", "-m", "later"]);
    write(dir, "staged-later.txt", "staged after snapshot\n");
    await git(dir, ["add", "staged-later.txt"]);

    await engine.restoreSnapshot(hash);

    const read = (rel: string) => fs.readFileSync(path.join(dir, rel), "utf8");
    assert.equal(read("a.txt"), "a good\n");
    assert.equal(read("committed-later.txt"), "committed after snapshot\n");
    assert.equal(read("staged-later.txt"), "staged after snapshot\n");
  });
});

describe("selective restore with glob-like file names", () => {
  it("treats names like [id].tsx literally and never touches unselected files", async () => {
    const { dir, engine } = await makeRepo();
    write(dir, "[id].tsx", "id good\n");
    write(dir, "i.tsx", "i good\n");
    write(dir, "app/[id]/page.tsx", "page good\n");
    write(dir, "app/d/page.tsx", "d good\n");
    const hash = await snapshotHash(engine);

    write(dir, "[id].tsx", "id BROKEN\n");
    write(dir, "i.tsx", "i mine\n");
    write(dir, "app/[id]/page.tsx", "page BROKEN\n");
    write(dir, "app/d/page.tsx", "d mine\n");

    await engine.restoreSnapshot(hash, ["[id].tsx", "app/[id]/page.tsx"]);

    const read = (rel: string) => fs.readFileSync(path.join(dir, rel), "utf8");
    assert.equal(read("[id].tsx"), "id good\n");
    assert.equal(read("app/[id]/page.tsx"), "page good\n");
    assert.equal(read("i.tsx"), "i mine\n", "glob [id] must not match i.tsx");
    assert.equal(read("app/d/page.tsx"), "d mine\n", "glob [id] must not match app/d/");
  });
});

describe("fileAtSnapshot", () => {
  it("returns stored contents, and undefined for absent paths", async () => {
    const { dir, engine } = await makeRepo();
    write(dir, "a.txt", "version 1\n");
    const hash = await snapshotHash(engine);
    write(dir, "a.txt", "version 2\n");

    assert.equal(await engine.fileAtSnapshot(hash, "a.txt"), "version 1\n");
    assert.equal(await engine.fileAtSnapshot(hash, "missing.txt"), undefined);
  });
});
