import * as vscode from "vscode";
import { SnapshotEngine } from "../snapshot/engine";

export const LKG_SCHEME = "lkg-snapshot";

/** URI whose content is `relPath` as stored in snapshot `hash`. */
export function snapshotUri(hash: string, relPath: string): vscode.Uri {
  return vscode.Uri.from({ scheme: LKG_SCHEME, path: `/${relPath}`, query: hash });
}

/** URI that always renders empty — the "current" side for not-yet-existing files. */
export function emptyUri(relPath: string): vscode.Uri {
  return vscode.Uri.from({ scheme: LKG_SCHEME, path: `/${relPath}`, query: "empty" });
}

/** Serves read-only file contents out of snapshot commits for vscode.diff. */
export class SnapshotContentProvider implements vscode.TextDocumentContentProvider {
  constructor(private readonly engine: SnapshotEngine) {}

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    if (uri.query === "empty") {
      return "";
    }
    const relPath = uri.path.replace(/^\//, "");
    return (await this.engine.fileAtSnapshot(uri.query, relPath)) ?? "";
  }
}
