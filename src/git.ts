import { execFile } from "node:child_process";

export type GitLogger = (message: string) => void;

let logger: GitLogger | undefined;

/** Route all git-call logging somewhere (e.g. a VS Code OutputChannel). */
export function setGitLogger(l: GitLogger | undefined): void {
  logger = l;
}

export class GitError extends Error {
  constructor(
    public readonly args: readonly string[],
    public readonly exitCode: number | string,
    public readonly stderr: string
  ) {
    super(`git ${args.join(" ")} failed (${exitCode}): ${stderr.trim()}`);
    this.name = "GitError";
  }
}

/**
 * Run git with an argument array (never a shell string — paths with spaces,
 * injection safety). Resolves with stdout; rejects with GitError.
 */
export function git(
  cwd: string,
  args: string[],
  extraEnv?: Record<string, string>
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      {
        cwd,
        env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
        maxBuffer: 64 * 1024 * 1024,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        const code = error ? ((error as NodeJS.ErrnoException).code ?? 1) : 0;
        logger?.(`git ${args.join(" ")}${error ? ` → exit ${code}` : ""}`);
        if (error) {
          reject(new GitError(args, code, String(stderr)));
        } else {
          resolve(String(stdout));
        }
      }
    );
  });
}
