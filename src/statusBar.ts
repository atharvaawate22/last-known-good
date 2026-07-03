import * as vscode from "vscode";
import { SnapshotEngine } from "./snapshot/engine";
import { relativeTime } from "./restore/restoreUi";

/** "LKG: 4m ago" status bar item; click opens the restore QuickPick. */
export class LkgStatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private timer: NodeJS.Timeout | undefined;
  private lastTimestamp: number | undefined;

  constructor(private readonly engine: SnapshotEngine) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
    this.item.command = "lastKnownGood.restore";
    this.item.tooltip = "Last Known Good — click to restore a snapshot";
    this.timer = setInterval(() => this.render(), 30_000);
    this.item.show();
  }

  /** Re-query the latest snapshot (call after snapshot/restore). */
  async refresh(): Promise<void> {
    const latest = (await this.engine.list())[0];
    this.lastTimestamp = latest?.timestamp;
    this.render();
  }

  private render(): void {
    this.item.text =
      this.lastTimestamp === undefined
        ? "LKG: none"
        : `LKG: ${relativeTime(this.lastTimestamp)}`;
  }

  dispose(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.item.dispose();
  }
}
