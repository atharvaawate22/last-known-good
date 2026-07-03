import * as vscode from "vscode";
import { SnapshotEngine } from "../snapshot/engine";

/**
 * Diagnostics signal: after a save inside the repo, wait for the debounce
 * window, then snapshot with trigger `compiled` if the workspace has zero
 * error-severity diagnostics. Never blocks the save — everything is async.
 */
export class DiagnosticsSignal implements vscode.Disposable {
  private timer: NodeJS.Timeout | undefined;
  private readonly saveSub: vscode.Disposable;
  private running = false;

  constructor(
    private readonly engine: SnapshotEngine,
    private readonly onCreated: () => void
  ) {
    this.saveSub = vscode.workspace.onDidSaveTextDocument((doc) => this.onSave(doc));
  }

  private static config(): {
    enabled: boolean;
    debounceMs: number;
    strict: boolean;
    excludeGlobs: string[];
  } {
    const c = vscode.workspace.getConfiguration("lastKnownGood");
    return {
      enabled: c.get<boolean>("autoSnapshot.enabled", true),
      debounceMs: Math.max(1, c.get<number>("autoSnapshot.debounceSeconds", 4)) * 1000,
      strict: c.get<string>("autoSnapshot.strictness", "errors") === "errors-and-warnings",
      excludeGlobs: c.get<string[]>("autoSnapshot.excludeGlobs", []),
    };
  }

  private onSave(doc: vscode.TextDocument): void {
    const { enabled, debounceMs, excludeGlobs } = DiagnosticsSignal.config();
    if (!enabled || doc.uri.scheme !== "file" || !this.engine.contains(doc.uri.fsPath)) {
      return;
    }
    const excluded = excludeGlobs.some(
      (glob) =>
        vscode.languages.match(
          { pattern: new vscode.RelativePattern(this.engine.repoRoot, glob) },
          doc
        ) > 0
    );
    if (excluded) {
      return;
    }
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => void this.check(), debounceMs);
  }

  private async check(): Promise<void> {
    const { enabled, strict } = DiagnosticsSignal.config();
    if (this.running || !enabled) {
      return;
    }
    const worst = strict
      ? vscode.DiagnosticSeverity.Warning
      : vscode.DiagnosticSeverity.Error;
    const hasBlockers = vscode.languages
      .getDiagnostics()
      .some(([, diags]) => diags.some((d) => d.severity <= worst));
    if (hasBlockers) {
      return;
    }
    this.running = true;
    try {
      const result = await this.engine.createSnapshot("compiled");
      if (result.kind === "created") {
        vscode.window.setStatusBarMessage("LKG: snapshot saved ✓ (no errors after save)", 3000);
        this.onCreated();
      }
    } catch {
      // failure already logged by the git wrapper; auto signals stay silent
    } finally {
      this.running = false;
    }
  }

  dispose(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.saveSub.dispose();
  }
}
