import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { git, GitError } from "../git";

export type TriggerType =
  | "manual"
  | "compiled"
  | "tests-passed"
  | "build-passed"
  | "pre-restore";

export interface Snapshot {
  ref: string;
  hash: string;
  timestamp: number; // Unix ms
  trigger: TriggerType;
}

export type SkipReason = "duplicate" | "operation-in-progress";

export type CreateResult =
  | { kind: "created"; snapshot: Snapshot }
  | { kind: "skipped"; reason: SkipReason };

export interface DiffEntry {
  /** A = will be created, M = will be overwritten, D = exists now but not in snapshot (left alone on restore) */
  status: "A" | "M" | "D";
  path: string;
}

const REF_PREFIX = "refs/lkg/";
const REF_RE = /^refs\/lkg\/(\d+)-([a-z-]+)$/;

// Retention: the newest KEEP_RECENT snapshots are always safe; older ones are
// thinned to one per hour for today and one per day beyond, capped at MAX_TOTAL.
const KEEP_RECENT = 10;
const MAX_TOTAL = 30;

/** Pure retention policy: which of these snapshots should be deleted at `now`. */
export function computePruneList(snapshots: Snapshot[], now = Date.now()): Snapshot[] {
  const sorted = [...snapshots].sort((a, b) => b.timestamp - a.timestamp);
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);

  const keep = new Set<Snapshot>();
  const seenBuckets = new Set<string>();
  for (const s of sorted) {
    if (keep.size < KEEP_RECENT) {
      keep.add(s);
      continue;
    }
    if (keep.size >= MAX_TOTAL) {
      break;
    }
    const bucket =
      s.timestamp >= startOfToday.getTime()
        ? `hour-${Math.floor(s.timestamp / 3_600_000)}`
        : `day-${new Date(s.timestamp).toDateString()}`;
    if (!seenBuckets.has(bucket)) {
      seenBuckets.add(bucket);
      keep.add(s);
    }
  }
  return sorted.filter((s) => !keep.has(s));
}

// Snapshots must round-trip the working tree byte-for-byte. With the Windows
// default core.autocrlf=true, a normal add/restore cycle rewrites LF files as
// CRLF — so every content operation (checkin AND checkout) runs with
// conversion off. Applies only to our shadow snapshots, never the user's git.
const NO_CONVERT = ["-c", "core.autocrlf=false"];

// commit-tree needs an identity; supply one so we never depend on user config.
const IDENT_ENV = {
  GIT_AUTHOR_NAME: "Last Known Good",
  GIT_AUTHOR_EMAIL: "lkg@localhost",
  GIT_COMMITTER_NAME: "Last Known Good",
  GIT_COMMITTER_EMAIL: "lkg@localhost",
};

/**
 * Snapshot engine built on git plumbing. Never touches the user's working
 * tree (except explicit restore), index, stash list, or visible history.
 * Snapshots live as commits pointed at by refs under refs/lkg/.
 */
export class SnapshotEngine {
  private constructor(public readonly repoRoot: string) {}

  /** Returns an engine if `folder` is inside a git work tree, else undefined. */
  static async open(folder: string): Promise<SnapshotEngine | undefined> {
    try {
      const top = (await git(folder, ["rev-parse", "--show-toplevel"])).trim();
      if (!top) {
        return undefined;
      }
      return new SnapshotEngine(top);
    } catch {
      return undefined;
    }
  }

  /** True while a merge/rebase/cherry-pick is in progress — do not snapshot then. */
  async operationInProgress(): Promise<boolean> {
    const gitDirRaw = (await git(this.repoRoot, ["rev-parse", "--git-dir"])).trim();
    const gitDir = path.resolve(this.repoRoot, gitDirRaw);
    return ["MERGE_HEAD", "rebase-merge", "rebase-apply", "CHERRY_PICK_HEAD"].some((p) =>
      fs.existsSync(path.join(gitDir, p))
    );
  }

  /**
   * Write the current working tree (tracked changes AND untracked files,
   * .gitignore respected) as a tree object using a temporary index.
   * The real index is never touched.
   */
  async currentTree(): Promise<string> {
    const tmpIndex = path.join(os.tmpdir(), `lkg-index-${crypto.randomUUID()}`);
    const env = { GIT_INDEX_FILE: tmpIndex };
    try {
      const head = await this.headCommit();
      if (head) {
        await git(this.repoRoot, ["read-tree", head], env);
      } else {
        await git(this.repoRoot, ["read-tree", "--empty"], env);
      }
      await git(this.repoRoot, [...NO_CONVERT, "add", "-A"], env);
      return (await git(this.repoRoot, ["write-tree"], env)).trim();
    } finally {
      fs.rm(tmpIndex, { force: true }, () => {});
    }
  }

  async createSnapshot(
    trigger: TriggerType,
    opts: { dedupe?: boolean } = {}
  ): Promise<CreateResult> {
    const dedupe = opts.dedupe ?? true;

    if (await this.operationInProgress()) {
      return { kind: "skipped", reason: "operation-in-progress" };
    }

    const tree = await this.currentTree();

    if (dedupe) {
      const latest = (await this.list())[0];
      if (latest && (await this.treeOf(latest.hash)) === tree) {
        return { kind: "skipped", reason: "duplicate" };
      }
    }

    const head = await this.headCommit();
    const timestamp = Date.now();
    const message = `LKG snapshot (${trigger}) ${new Date(timestamp).toISOString()}`;
    const commitArgs = ["commit-tree", tree, ...(head ? ["-p", head] : []), "-m", message];
    const hash = (await git(this.repoRoot, commitArgs, IDENT_ENV)).trim();

    const ref = `${REF_PREFIX}${timestamp}-${trigger}`;
    await git(this.repoRoot, ["update-ref", ref, hash]);

    return { kind: "created", snapshot: { ref, hash, timestamp, trigger } };
  }

  /** All snapshots, newest first. */
  async list(): Promise<Snapshot[]> {
    const out = await git(this.repoRoot, [
      "for-each-ref",
      "--format=%(refname)%09%(objectname)",
      REF_PREFIX.replace(/\/$/, ""),
    ]);
    const snapshots: Snapshot[] = [];
    for (const line of out.split("\n")) {
      if (!line.trim()) {
        continue;
      }
      const [ref, hash] = line.split("\t");
      const m = REF_RE.exec(ref);
      if (!m) {
        continue;
      }
      snapshots.push({
        ref,
        hash,
        timestamp: Number(m[1]),
        trigger: m[2] as TriggerType,
      });
    }
    snapshots.sort((a, b) => b.timestamp - a.timestamp);
    return snapshots;
  }

  async treeOf(commitHash: string): Promise<string> {
    return (await git(this.repoRoot, ["rev-parse", `${commitHash}^{tree}`])).trim();
  }

  /** Diff two trees. Status is relative to going FROM fromTree TO toTree. */
  async diffTrees(fromTree: string, toTree: string): Promise<DiffEntry[]> {
    const out = await git(this.repoRoot, [
      "diff-tree",
      "-r",
      "--name-status",
      "-z",
      fromTree,
      toTree,
    ]);
    const parts = out.split("\0").filter((p) => p.length > 0);
    const entries: DiffEntry[] = [];
    for (let i = 0; i + 1 < parts.length; i += 2) {
      const status = parts[i][0];
      if (status === "A" || status === "M" || status === "D") {
        entries.push({ status, path: parts[i + 1] });
      }
    }
    return entries;
  }

  /**
   * Overwrite the working tree with the snapshot's contents — all of it, or
   * only `paths` (repo-relative, forward slashes). Only paths that exist in
   * the snapshot are written; files created since are left alone. The index
   * and HEAD are untouched. Callers MUST take a safety snapshot first (see
   * restoreSnapshot).
   */
  async applySnapshot(hash: string, paths?: string[]): Promise<void> {
    await git(this.repoRoot, [
      ...NO_CONVERT,
      "restore",
      "--source",
      hash,
      "--worktree",
      "--",
      ...(paths && paths.length > 0 ? paths : ["."]),
    ]);
  }

  /** Contents of one file as stored in a snapshot, or undefined if absent. */
  async fileAtSnapshot(hash: string, relPath: string): Promise<string | undefined> {
    try {
      return await git(this.repoRoot, [...NO_CONVERT, "show", `${hash}:${relPath}`]);
    } catch {
      return undefined;
    }
  }

  /**
   * Full or selective restore: safety snapshot of the current (presumed
   * broken) state, then apply. Restore is therefore always itself undoable.
   */
  async restoreSnapshot(hash: string, paths?: string[]): Promise<{ safety: Snapshot }> {
    const safety = await this.createSnapshot("pre-restore", { dedupe: false });
    if (safety.kind !== "created") {
      throw new Error(`Refusing to restore: could not create safety snapshot (${safety.reason})`);
    }
    try {
      await this.applySnapshot(hash, paths);
    } catch (e) {
      if (e instanceof GitError) {
        throw new Error(
          `Restore failed (${e.message}). Your pre-restore state is saved at ${safety.snapshot.ref}.`
        );
      }
      throw e;
    }
    return { safety: safety.snapshot };
  }

  /** Apply the retention policy. Returns how many snapshots were deleted. */
  async prune(now = Date.now()): Promise<number> {
    const doomed = computePruneList(await this.list(), now);
    for (const s of doomed) {
      await this.deleteSnapshot(s.ref);
    }
    return doomed.length;
  }

  /** True if fsPath is inside this repo's work tree. */
  contains(fsPath: string): boolean {
    const fold = (p: string) => (process.platform === "win32" ? p.toLowerCase() : p);
    const rel = path.relative(fold(this.repoRoot), fold(fsPath));
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  }

  /** Delete a snapshot ref. */
  async deleteSnapshot(ref: string): Promise<void> {
    if (!ref.startsWith(REF_PREFIX)) {
      throw new Error(`Not an LKG ref: ${ref}`);
    }
    await git(this.repoRoot, ["update-ref", "-d", ref]);
  }

  private async headCommit(): Promise<string | undefined> {
    try {
      return (await git(this.repoRoot, ["rev-parse", "--verify", "--quiet", "HEAD"])).trim();
    } catch {
      return undefined; // repo with no commits yet
    }
  }
}
