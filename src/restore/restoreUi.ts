import * as path from "node:path";
import * as vscode from "vscode";
import { DiffEntry, Snapshot, SnapshotEngine } from "../snapshot/engine";
import { emptyUri, snapshotUri } from "./snapshotContentProvider";

export const TRIGGER_BADGE: Record<Snapshot["trigger"], string> = {
  manual: "★ manual",
  compiled: "✓ compiled",
  "tests-passed": "✓✓ tests",
  "build-passed": "✓✓ build",
  "pre-restore": "↩ pre-restore",
};

export function relativeTime(timestamp: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - timestamp) / 1000));
  if (s < 45) {
    return "just now";
  }
  const m = Math.round(s / 60);
  if (m < 60) {
    return `${m}m ago`;
  }
  const h = Math.round(m / 60);
  if (h < 24) {
    return `${h}h ago`;
  }
  const d = Math.round(h / 24);
  return `${d}d ago`;
}

interface SnapshotItem extends vscode.QuickPickItem {
  snapshot: Snapshot;
  changes: DiffEntry[];
}

interface FileItem extends vscode.QuickPickItem {
  entry: DiffEntry;
}

const DIFF_BUTTON: vscode.QuickInputButton = {
  iconPath: new vscode.ThemeIcon("diff"),
  tooltip: "Preview diff (snapshot ↔ current)",
};

/**
 * The `lastKnownGood.restore` command. When `preselected` is given (timeline
 * click) the snapshot QuickPick is skipped. Returns true if a restore happened.
 */
export async function runRestore(
  engine: SnapshotEngine,
  preselected?: Snapshot
): Promise<boolean> {
  let snapshot: Snapshot;
  let changes: DiffEntry[];

  if (preselected) {
    snapshot = preselected;
    const currentTree = await engine.currentTree();
    changes = await engine.diffTrees(currentTree, await engine.treeOf(snapshot.hash));
  } else {
    const snapshots = await engine.list();
    if (snapshots.length === 0) {
      vscode.window.showInformationMessage(
        'Last Known Good: no snapshots yet. Run "Mark as Good" when your code works.'
      );
      return false;
    }

    const currentTree = await engine.currentTree();
    const items: SnapshotItem[] = [];
    for (const snap of snapshots) {
      const snapChanges = await engine.diffTrees(currentTree, await engine.treeOf(snap.hash));
      const affected = snapChanges.filter((c) => c.status !== "D").length;
      items.push({
        snapshot: snap,
        changes: snapChanges,
        label: `${TRIGGER_BADGE[snap.trigger]} — ${relativeTime(snap.timestamp)}`,
        description:
          affected === 0 ? "identical to current state" : `${affected} file(s) differ`,
        detail: new Date(snap.timestamp).toLocaleString(),
      });
    }

    const picked = await vscode.window.showQuickPick(items, {
      placeHolder:
        "Restore which snapshot? (a safety snapshot of the current state is taken first)",
      matchOnDescription: true,
    });
    if (!picked) {
      return false;
    }
    snapshot = picked.snapshot;
    changes = picked.changes;
  }

  const toWrite = changes.filter((c) => c.status !== "D");
  const leftAlone = changes.length - toWrite.length;
  if (toWrite.length === 0) {
    vscode.window.showInformationMessage(
      "Last Known Good: that snapshot is identical to the current state — nothing to restore."
    );
    return false;
  }

  const selected = await pickFiles(engine, snapshot, toWrite, leftAlone);
  if (!selected || selected.length === 0) {
    return false;
  }

  const fileList = selected
    .slice(0, 15)
    .map((c) => `${c.status === "A" ? "create" : "overwrite"}  ${c.path}`)
    .join("\n");
  const more = selected.length > 15 ? `\n…and ${selected.length - 15} more` : "";
  const leftNote =
    leftAlone > 0
      ? `\n\n${leftAlone} file(s) created since the snapshot will be left untouched.`
      : "";
  const partialNote =
    selected.length < toWrite.length
      ? `\n\nPartial restore: ${toWrite.length - selected.length} differing file(s) deselected and left as-is.`
      : "";

  const confirm = await vscode.window.showWarningMessage(
    `Restore snapshot from ${relativeTime(snapshot.timestamp)}? ${selected.length} file(s) will be written.`,
    {
      modal: true,
      detail: `${fileList}${more}${leftNote}${partialNote}\n\nA safety snapshot of the current state is saved first, so this is undoable.`,
    },
    "Restore"
  );
  if (confirm !== "Restore") {
    return false;
  }

  const paths =
    selected.length < toWrite.length ? selected.map((c) => c.path) : undefined;
  const { safety } = await engine.restoreSnapshot(snapshot.hash, paths);
  vscode.window.showInformationMessage(
    `Last Known Good: restored ${selected.length} file(s). Pre-restore state saved (${TRIGGER_BADGE[safety.trigger]}).`
  );
  return true;
}

/**
 * Per-file selection step. Everything starts checked (full restore is the
 * default); each row has a diff button for previewing snapshot ↔ current.
 * Resolves with the chosen entries, or undefined if cancelled.
 */
function pickFiles(
  engine: SnapshotEngine,
  snapshot: Snapshot,
  toWrite: DiffEntry[],
  leftAlone: number
): Promise<DiffEntry[] | undefined> {
  return new Promise((resolve) => {
    const qp = vscode.window.createQuickPick<FileItem>();
    qp.canSelectMany = true;
    qp.ignoreFocusOut = true; // survive focus moving to a diff preview
    qp.title = `Restore ${TRIGGER_BADGE[snapshot.trigger]} — ${relativeTime(snapshot.timestamp)}`;
    qp.placeholder =
      "Files to restore (uncheck to keep the current version)" +
      (leftAlone > 0 ? ` — ${leftAlone} newer file(s) untouched either way` : "");
    qp.items = toWrite.map((entry) => ({
      entry,
      label: entry.path,
      description: entry.status === "A" ? "will be created" : "will be overwritten",
      buttons: [DIFF_BUTTON],
    }));
    qp.selectedItems = qp.items;

    qp.onDidTriggerItemButton((e) => {
      const { entry } = e.item;
      const left = snapshotUri(snapshot.hash, entry.path);
      const right =
        entry.status === "A"
          ? emptyUri(entry.path)
          : vscode.Uri.file(path.join(engine.repoRoot, entry.path));
      void vscode.commands.executeCommand(
        "vscode.diff",
        left,
        right,
        `${entry.path} (snapshot ↔ current)`,
        { preview: true, preserveFocus: false }
      );
    });

    let accepted = false;
    qp.onDidAccept(() => {
      accepted = true;
      const chosen = qp.selectedItems.map((i) => i.entry);
      qp.hide();
      resolve(chosen);
    });
    qp.onDidHide(() => {
      qp.dispose();
      if (!accepted) {
        resolve(undefined);
      }
    });
    qp.show();
  });
}
