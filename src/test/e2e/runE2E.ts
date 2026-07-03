import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runTests } from "@vscode/test-electron";

function sh(cwd: string, cmd: string, args: string[]): void {
  execFileSync(cmd, args, { cwd, stdio: "pipe" });
}

async function main(): Promise<void> {
  // When launched from a VS Code terminal this is set and leaks into the
  // spawned test instance, making Electron treat argv[1] as a JS module.
  delete process.env.ELECTRON_RUN_AS_NODE;

  const extensionDevelopmentPath = path.resolve(__dirname, "..", "..", "..");

  // Workspace 1: a real git repo with a base commit and LKG settings.
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "lkg-e2e-ws-"));
  sh(ws, "git", ["init", "-b", "main"]);
  sh(ws, "git", ["config", "user.name", "E2E"]);
  sh(ws, "git", ["config", "user.email", "e2e@test.local"]);
  fs.writeFileSync(path.join(ws, "base.txt"), "original\n");
  fs.mkdirSync(path.join(ws, ".vscode"), { recursive: true });
  fs.writeFileSync(
    path.join(ws, ".vscode", "settings.json"),
    JSON.stringify(
      {
        "lastKnownGood.autoSnapshot.enabled": true,
        "lastKnownGood.autoSnapshot.debounceSeconds": 1,
        "lastKnownGood.testTasks": ["smoke"],
      },
      null,
      2
    )
  );
  fs.writeFileSync(
    path.join(ws, ".vscode", "tasks.json"),
    JSON.stringify(
      {
        version: "2.0.0",
        tasks: [{ label: "smoke", type: "shell", command: "echo ok" }],
      },
      null,
      2
    )
  );
  sh(ws, "git", ["add", "-A"]);
  sh(ws, "git", ["commit", "-m", "base"]);

  const commonArgs = [
    "--disable-extensions",
    "--disable-workspace-trust",
    "--skip-welcome",
    "--skip-release-notes",
  ];

  console.log(`[e2e] git workspace: ${ws}`);
  await runTests({
    extensionDevelopmentPath,
    extensionTestsPath: path.resolve(__dirname, "suite"),
    launchArgs: [ws, ...commonArgs],
  });
  console.log("[e2e] PASS: git workspace scenario");

  // Workspace 2: NOT a git repo — the extension must stay dormant.
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), "lkg-e2e-plain-"));
  fs.writeFileSync(path.join(plain, "notes.txt"), "hello\n");

  console.log(`[e2e] non-repo workspace: ${plain}`);
  await runTests({
    extensionDevelopmentPath,
    extensionTestsPath: path.resolve(__dirname, "suiteNoRepo"),
    launchArgs: [plain, ...commonArgs],
  });
  console.log("[e2e] PASS: non-repo dormancy scenario");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
