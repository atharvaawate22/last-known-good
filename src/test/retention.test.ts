import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { git } from "../git";
import { computePruneList, Snapshot, SnapshotEngine } from "../snapshot/engine";

// A fixed local "now": 2026-07-04 12:00:00.
const NOW = new Date(2026, 6, 4, 12, 0, 0).getTime();
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function snap(timestamp: number): Snapshot {
  return {
    ref: `refs/lkg/${timestamp}-manual`,
    hash: "0".repeat(40),
    timestamp,
    trigger: "manual",
  };
}

/** n snapshots one minute apart, newest at `newest`. */
function series(n: number, newest: number): Snapshot[] {
  return Array.from({ length: n }, (_, i) => snap(newest - i * 60_000));
}

describe("computePruneList", () => {
  it("prunes nothing when at or under the always-keep window", () => {
    assert.deepEqual(computePruneList(series(10, NOW - HOUR), NOW), []);
    assert.deepEqual(computePruneList([], NOW), []);
  });

  it("thins today's snapshots beyond the recent window to one per hour", () => {
    // 15 snapshots, one minute apart, all inside the same clock hour today.
    const snaps = series(15, NOW - 5 * 60_000);
    const pruned = computePruneList(snaps, NOW);
    // Newest 10 kept; of the remaining 5 (same hour bucket) the newest is
    // kept, the 4 oldest pruned.
    assert.deepEqual(
      pruned.map((s) => s.timestamp).sort(),
      snaps.slice(11).map((s) => s.timestamp).sort()
    );
  });

  it("thins snapshots from previous days to one per day", () => {
    // 3 per day across 5 old days (newest first: days -1 .. -5).
    const snaps: Snapshot[] = [];
    for (let day = 1; day <= 5; day++) {
      for (let k = 0; k < 3; k++) {
        snaps.push(snap(NOW - day * DAY - k * 60_000));
      }
    }
    const pruned = computePruneList(snaps, NOW);
    // Newest 10 = days -1..-3 fully (9) + newest of day -4.
    // Remaining: day -4 has 2 left → bucket keeps its newest, prunes 1;
    // day -5 has 3 → keeps newest, prunes 2.
    assert.equal(pruned.length, 3);
    const prunedTs = new Set(pruned.map((s) => s.timestamp));
    assert.ok(prunedTs.has(NOW - 4 * DAY - 2 * 60_000)); // oldest of day -4
    assert.ok(prunedTs.has(NOW - 5 * DAY - 60_000));
    assert.ok(prunedTs.has(NOW - 5 * DAY - 2 * 60_000));
  });

  it("caps total retained snapshots at 30", () => {
    // One snapshot per day for 50 days — every one is its own daily bucket,
    // so only the cap can remove any.
    const snaps = Array.from({ length: 50 }, (_, i) => snap(NOW - (i + 1) * DAY));
    const pruned = computePruneList(snaps, NOW);
    assert.equal(pruned.length, 20);
    // The pruned ones are exactly the 20 oldest.
    assert.deepEqual(
      pruned.map((s) => s.timestamp).sort(),
      snaps.slice(30).map((s) => s.timestamp).sort()
    );
  });
});

describe("SnapshotEngine.prune (integration)", () => {
  const tempDirs: string[] = [];
  after(() => {
    for (const dir of tempDirs) {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    }
  });

  it("deletes thinned refs from the repo", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lkg-prune-"));
    tempDirs.push(dir);
    await git(dir, ["init", "-b", "main"]);
    await git(dir, ["config", "user.name", "Test"]);
    await git(dir, ["config", "user.email", "test@test.local"]);
    fs.writeFileSync(path.join(dir, "a.txt"), "hello\n");

    const engine = await SnapshotEngine.open(dir);
    assert.ok(engine);
    const created = await engine.createSnapshot("manual");
    assert.equal(created.kind, "created");
    const hash = (created as { kind: "created"; snapshot: { hash: string } }).snapshot.hash;

    // Fabricate 12 refs on one day last month, pointing at the same commit.
    const oldDay = new Date(2026, 5, 10, 9, 0, 0).getTime();
    for (let i = 0; i < 12; i++) {
      await git(dir, ["update-ref", `refs/lkg/${oldDay + i * 60_000}-manual`, hash]);
    }
    assert.equal((await engine.list()).length, 13);

    // Newest 10 kept (today's + 9 of the old day); the old day's remaining 3
    // collapse to their newest → 2 pruned, 11 left.
    const pruned = await engine.prune();
    assert.equal(pruned, 2);
    const remaining = await engine.list();
    assert.equal(remaining.length, 11);
    assert.equal(remaining[remaining.length - 1].timestamp, oldDay + 2 * 60_000);
  });
});

describe("SnapshotEngine.contains", () => {
  const tempDirs: string[] = [];
  after(() => {
    for (const dir of tempDirs) {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    }
  });

  it("accepts paths inside the repo and rejects outside ones", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lkg-contains-"));
    tempDirs.push(dir);
    await git(dir, ["init", "-b", "main"]);
    const engine = await SnapshotEngine.open(dir);
    assert.ok(engine);

    assert.ok(engine.contains(path.join(dir, "src", "x.ts")));
    assert.ok(engine.contains(dir));
    assert.ok(!engine.contains(os.tmpdir()));
    assert.ok(!engine.contains(path.join(dir, "..", "elsewhere", "x.ts")));
  });
});
