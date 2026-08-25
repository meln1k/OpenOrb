import { parseArgs } from "@std/cli/parse-args";

export interface RunnerStartOptions {
  gateway?: string;
  enrollmentToken?: string;
  name: string;
  maxConcurrentSessions?: number;
  vmCpuCount?: number;
  vmMemoryMiB?: number;
}

export type RunnerCommand =
  | { type: "start"; options: RunnerStartOptions }
  | { type: "doctor" }
  | { type: "version" };

export class RunnerOptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunnerOptionError";
  }
}

export function parseRunnerCommand(args: string[]): RunnerCommand {
  if (args.length === 1 && (args[0] === "--version" || args[0] === "version")) {
    return { type: "version" };
  }
  if (args.length === 1 && args[0] === "doctor") return { type: "doctor" };

  const parsed = parseArgs(args, {
    string: [
      "gateway",
      "enrollment-token",
      "name",
      "max-concurrent-sessions",
      "vm-cpu-count",
      "vm-memory-mib",
    ],
    unknown(_argument, key) {
      if (key === "data-dir") {
        throw new RunnerOptionError(
          "--data-dir is not supported. Start the runner from its canonical working directory.",
        );
      }
      throw new RunnerOptionError("Unknown argument.");
    },
  });
  if (parsed._.length > 0) throw new RunnerOptionError("Unknown argument.");

  const options: RunnerStartOptions = { name: "OpenOrb runner" };
  if (parsed.gateway !== undefined) {
    if (!parsed.gateway) throw new RunnerOptionError("--gateway requires a value.");
    options.gateway = normalizeGatewayUrl(parsed.gateway);
  }
  if (parsed["enrollment-token"] !== undefined) {
    if (!parsed["enrollment-token"]) {
      throw new RunnerOptionError("--enrollment-token requires a value.");
    }
    options.enrollmentToken = parsed["enrollment-token"];
  }
  if (parsed.name !== undefined) {
    const name = parsed.name.trim();
    if (name.length === 0 || name.length > 100) {
      throw new RunnerOptionError("--name must contain between 1 and 100 characters.");
    }
    options.name = name;
  }
  if (parsed["max-concurrent-sessions"] !== undefined) {
    options.maxConcurrentSessions = parsePositiveInteger(
      parsed["max-concurrent-sessions"],
      "--max-concurrent-sessions",
    );
  }
  if (parsed["vm-cpu-count"] !== undefined) {
    options.vmCpuCount = parsePositiveInteger(parsed["vm-cpu-count"], "--vm-cpu-count");
  }
  if (parsed["vm-memory-mib"] !== undefined) {
    options.vmMemoryMiB = parsePositiveInteger(parsed["vm-memory-mib"], "--vm-memory-mib");
  }

  return { type: "start", options };
}

function parsePositiveInteger(input: string, flag: string): number {
  const value = Number(input);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RunnerOptionError(`${flag} must be a positive integer.`);
  }
  return value;
}

export function normalizeGatewayUrl(input: string): string {
  const url = new URL(input);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new RunnerOptionError("--gateway must use http or https.");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new RunnerOptionError(
      "--gateway must not contain credentials, a query, or a fragment.",
    );
  }
  if (url.pathname !== "/") {
    throw new RunnerOptionError("--gateway must be an origin URL without a path.");
  }
  return url.origin;
}
