import * as vscode from "vscode";
import { SnapshotEngine, TriggerType } from "../snapshot/engine";

/**
 * Task signal: when a user-designated task ends with exit code 0, snapshot
 * with trigger `tests-passed` or `build-passed`. Which task names count is
 * chosen by the user via lastKnownGood.testTasks / lastKnownGood.buildTasks.
 */
export class TaskSignal implements vscode.Disposable {
  private readonly sub: vscode.Disposable;

  constructor(
    private readonly engine: SnapshotEngine,
    private readonly onCreated: () => void
  ) {
    this.sub = vscode.tasks.onDidEndTaskProcess((e) => void this.onTaskEnd(e));
  }

  private async onTaskEnd(e: vscode.TaskProcessEndEvent): Promise<void> {
    if (e.exitCode !== 0) {
      return;
    }
    const c = vscode.workspace.getConfiguration("lastKnownGood");
    const name = e.execution.task.name;
    let trigger: TriggerType | undefined;
    if (c.get<string[]>("testTasks", []).includes(name)) {
      trigger = "tests-passed";
    } else if (c.get<string[]>("buildTasks", []).includes(name)) {
      trigger = "build-passed";
    }
    if (!trigger) {
      return;
    }
    try {
      const result = await this.engine.createSnapshot(trigger);
      if (result.kind === "created") {
        vscode.window.setStatusBarMessage(
          `LKG: snapshot saved ✓✓ (task "${name}" succeeded)`,
          3000
        );
        this.onCreated();
      }
    } catch {
      // failure already logged by the git wrapper; auto signals stay silent
    }
  }

  dispose(): void {
    this.sub.dispose();
  }
}
