import { spawn } from "node:child_process";

/** Native child-process execution; never invoke a shell for runner tooling. */
export async function execute(
  command: string,
  options: {
    args: string[];
    stdin?: "null" | "piped";
    stdout?: "null" | "piped";
    stderr?: "null" | "piped";
    input?: string;
    cwd?: string;
    env?: Record<string, string>;
  },
): Promise<{ success: boolean; code: number; stdout: Uint8Array; stderr: Uint8Array }> {
  const child = spawn(command, options.args, {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    env: options.env === undefined ? process.env : { ...process.env, ...options.env },
    stdio: [
      options.input === undefined ? "ignore" : "pipe",
      options.stdout === "null" ? "ignore" : "pipe",
      options.stderr === "null" ? "ignore" : "pipe",
    ],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
  return await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.stdin?.once("error", reject);
    if (options.input !== undefined) child.stdin?.end(options.input);
    child.once("close", (code) =>
      resolve({
        success: code === 0,
        code: code ?? 1,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
      }),
    );
  });
}
