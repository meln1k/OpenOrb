import { statfs as readFileSystemStats } from "node:fs/promises";

import type { RunnerCapacity } from "@openorb/protocol";

const MIB_BYTES = 1024 * 1024;
const MIB_BYTES_BIGINT = BigInt(MIB_BYTES);

export interface RunnerCapacityReporterOptions {
  path: string;
  maxConcurrentSessions?: number;
  vmCpuCount?: number;
  vmMemoryMiB?: number;
  getActiveSessions?: () => number;
  getHardwareConcurrency?: () => number;
  getSystemMemoryInfo?: () => { total: number };
  getFileSystemStats?: (path: string) => Promise<{ bavail: bigint; bsize: bigint }>;
}

export function createRunnerCapacityReporter(
  options: RunnerCapacityReporterOptions,
): () => Promise<RunnerCapacity> {
  const maxConcurrentSessions = options.maxConcurrentSessions;
  const vmCpuCount = options.vmCpuCount ??
    (options.getHardwareConcurrency ?? (() => navigator.hardwareConcurrency))();
  const vmMemoryMiB = options.vmMemoryMiB ?? Math.floor(
    (options.getSystemMemoryInfo ?? Deno.systemMemoryInfo)().total / MIB_BYTES,
  );
  const getActiveSessions = options.getActiveSessions ?? (() => 0);
  const getFileSystemStats = options.getFileSystemStats ??
    ((path) => readFileSystemStats(path, { bigint: true }));

  assertPositiveInteger(vmCpuCount, "VM CPU count");
  assertPositiveInteger(vmMemoryMiB, "VM memory");
  if (maxConcurrentSessions !== undefined) {
    assertPositiveInteger(maxConcurrentSessions, "Maximum concurrent sessions");
  }

  return async () => {
    const activeSessions = getActiveSessions();
    assertNonNegativeInteger(activeSessions, "Active session count");
    const fileSystem = await getFileSystemStats(options.path);
    const diskFreeMiB = toSafeInteger(fileSystem.bavail * fileSystem.bsize / MIB_BYTES_BIGINT);

    return {
      ...(maxConcurrentSessions === undefined ? {} : { maxConcurrentSessions }),
      activeSessions,
      vmCpuCount,
      vmMemoryMiB,
      diskFreeMiB,
    };
  };
}

function toSafeInteger(value: bigint): number {
  return Number(value > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : value);
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
}

function assertNonNegativeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer.`);
  }
}
