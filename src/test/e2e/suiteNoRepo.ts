import * as assert from "node:assert/strict";
import * as vscode from "vscode";

/** In a non-git workspace the extension must stay dormant: no commands registered. */
export async function run(): Promise<void> {
  const ext = vscode.extensions.getExtension("lkg-dev.last-known-good");
  assert.ok(ext, "extension not found in test host");
  await ext.activate();

  const cmds = await vscode.commands.getCommands(true);
  for (const id of ["lastKnownGood.markAsGood", "lastKnownGood.restore"]) {
    assert.ok(
      !cmds.includes(id),
      `${id} must not be registered in a non-git workspace`
    );
  }
  console.log("[e2e] non-repo workspace: extension stayed dormant (no commands registered)");
}
