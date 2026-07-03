import * as vscode from "vscode";
import { setGitLogger } from "./git";
import { SnapshotEngine } from "./snapshot/engine";
import { relativeTime, runRestore, TRIGGER_BADGE } from "./restore/restoreUi";
import { LKG_SCHEME, SnapshotContentProvider } from "./restore/snapshotContentProvider";
import { SnapshotNode, TimelineProvider } from "./restore/timelineView";
import { LkgStatusBar } from "./statusBar";
import { DiagnosticsSignal } from "./signals/diagnosticsSignal";
import { TaskSignal } from "./signals/taskSignal";

const NOT_A_REPO_NOTICE_KEY = "lkg.notARepoNoticeShown";

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder || folder.uri.scheme !== "file") {
    return; // no local workspace — stay dormant
  }

  const output = vscode.window.createOutputChannel("Last Known Good");
  context.subscriptions.push(output);
  setGitLogger((msg) => output.appendLine(msg));

  const engine = await SnapshotEngine.open(folder.uri.fsPath);
  if (!engine) {
    // Friendly one-time message, then stay dormant.
    if (!context.globalState.get<boolean>(NOT_A_REPO_NOTICE_KEY)) {
      await context.globalState.update(NOT_A_REPO_NOTICE_KEY, true);
      vscode.window.showInformationMessage(
        "Last Known Good needs a git repository to store snapshots. It will stay dormant in this workspace."
      );
    }
    return;
  }

  const statusBar = new LkgStatusBar(engine);
  context.subscriptions.push(statusBar);

  const timeline = new TimelineProvider(engine);
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider("lastKnownGood.timeline", timeline),
    vscode.workspace.registerTextDocumentContentProvider(
      LKG_SCHEME,
      new SnapshotContentProvider(engine)
    )
  );

  // After any snapshot: refresh the status bar and timeline, and apply
  // retention, without ever blocking the caller.
  const snapshotCreated = (): void => {
    void statusBar.refresh();
    timeline.refresh();
    engine.prune().then(
      (n) => {
        if (n > 0) {
          output.appendLine(`retention: pruned ${n} old snapshot(s)`);
        }
      },
      (e) => output.appendLine(`retention failed: ${e instanceof Error ? e.message : e}`)
    );
  };

  context.subscriptions.push(
    new DiagnosticsSignal(engine, snapshotCreated),
    new TaskSignal(engine, snapshotCreated),

    vscode.commands.registerCommand("lastKnownGood.markAsGood", async () => {
      try {
        const result = await engine.createSnapshot("manual");
        if (result.kind === "created") {
          vscode.window.setStatusBarMessage("Last Known Good: snapshot saved ★", 4000);
          snapshotCreated();
        } else if (result.reason === "duplicate") {
          vscode.window.setStatusBarMessage(
            "Last Known Good: no changes since the last snapshot",
            4000
          );
        } else {
          vscode.window.showWarningMessage(
            "Last Known Good: a merge/rebase is in progress — snapshot skipped."
          );
        }
      } catch (e) {
        showError("snapshot failed", e, output);
      }
    }),

    vscode.commands.registerCommand("lastKnownGood.restore", async () => {
      try {
        if (await runRestore(engine)) {
          snapshotCreated(); // a restore creates the pre-restore safety snapshot
        }
      } catch (e) {
        showError("restore failed", e, output);
      }
    }),

    vscode.commands.registerCommand(
      "lastKnownGood.restoreSnapshot",
      async (node: SnapshotNode) => {
        try {
          if (await runRestore(engine, node.snapshot)) {
            snapshotCreated();
          }
        } catch (e) {
          showError("restore failed", e, output);
        }
      }
    ),

    vscode.commands.registerCommand(
      "lastKnownGood.deleteSnapshot",
      async (node: SnapshotNode) => {
        const { snapshot } = node;
        const confirm = await vscode.window.showWarningMessage(
          `Delete snapshot ${TRIGGER_BADGE[snapshot.trigger]} from ${relativeTime(snapshot.timestamp)}?`,
          { modal: true },
          "Delete"
        );
        if (confirm !== "Delete") {
          return;
        }
        try {
          await engine.deleteSnapshot(snapshot.ref);
          void statusBar.refresh();
          timeline.refresh();
        } catch (e) {
          showError("delete failed", e, output);
        }
      }
    ),

    vscode.commands.registerCommand("lastKnownGood.refreshTimeline", () => {
      timeline.refresh();
    })
  );

  await statusBar.refresh();

  // Multi-root note: v1 intentionally handles only the first workspace folder.
  if ((vscode.workspace.workspaceFolders?.length ?? 0) > 1) {
    output.appendLine(
      "Multi-root workspace detected: Last Known Good v1 only snapshots the first folder."
    );
  }
}

function showError(what: string, e: unknown, output: vscode.OutputChannel): void {
  const message = e instanceof Error ? e.message : String(e);
  output.appendLine(`ERROR: ${what}: ${message}`);
  vscode.window
    .showErrorMessage(`Last Known Good: ${what}. ${message}`, "Show Log")
    .then((choice) => {
      if (choice === "Show Log") {
        output.show();
      }
    });
}

export function deactivate(): void {}
