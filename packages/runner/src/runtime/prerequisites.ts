import { statfs as readFileSystemStats } from "node:fs/promises";

import { tryAsync } from "@openorb/result";
import { object, parse, string } from "@remix-run/data-schema";

export const REQUIRED_DENO_VERSION = "2.9.5";
export const MINIMUM_GLIBC_VERSION = "2.27";
const MIB_BYTES = 1024 * 1024;
const MIB_BYTES_BIGINT = BigInt(MIB_BYTES);
const GATEWAY_TIMEOUT_MS = 15_000;
const KVM_DEVICE = "/dev/kvm";
const QMP_QUIT_COMMANDS = '{"execute":"qmp_capabilities"}\n{"execute":"quit"}\n';
const SUPPORTED_ARCHITECTURES = new Set(["arm64", "x64"]);
const SUPPORTED_PLATFORMS = new Set(["darwin", "linux"]);
const GLIBC_PATHS = {
  arm64: [
    "/lib/aarch64-linux-gnu/libc.so.6",
    "/usr/lib/aarch64-linux-gnu/libc.so.6",
    "/lib64/libc.so.6",
    "/usr/lib64/libc.so.6",
    "/lib/libc.so.6",
    "/usr/lib/libc.so.6",
  ],
  x64: [
    "/lib/x86_64-linux-gnu/libc.so.6",
    "/usr/lib/x86_64-linux-gnu/libc.so.6",
    "/lib64/libc.so.6",
    "/usr/lib64/libc.so.6",
    "/lib/libc.so.6",
    "/usr/lib/libc.so.6",
  ],
} as const;
const gatewayHealthSchema = object(
  { service: string(), status: string() },
  { unknownKeys: "error" },
);

export type RunnerPlatform = "darwin" | "linux" | string;
export type RunnerLibc = "glibc" | "musl" | "unknown";

interface DetectedLibc {
  libc: RunnerLibc | undefined;
  glibcVersion: string | undefined;
}

export interface PrerequisiteReport {
  ok: boolean;
  platform: RunnerPlatform;
  architecture: string;
  kernelRelease: string;
  denoVersion: string;
  libc: RunnerLibc | undefined;
  glibcVersion: string | undefined;
  qemu: ExecutableReport | undefined;
  qemuImg: ExecutableReport | undefined;
  kvm: {
    device: string;
    accessible: true;
  } | undefined;
  resources: {
    cpuCount: number;
    memoryTotalMiB: number;
    memoryAvailableMiB: number;
    diskFreeMiB: number;
  };
  dataDirectory: {
    path: string;
    writable: boolean;
  };
  gateway: {
    url: string;
    healthUrl: string;
    status: number;
  } | undefined;
  errors: string[];
  warnings: string[];
}

export interface ExecutableReport {
  executable: string;
  version: string;
}

export interface CheckPrerequisitesOptions {
  platform?: RunnerPlatform;
  architecture?: string;
  kernelRelease?: string;
  denoVersion?: string;
  libc?: RunnerLibc | undefined;
  glibcVersion?: string | undefined;
  workingDirectory?: string;
  gatewayUrl?: string;
  probeExecutable?: (executable: string, args: string[]) => Promise<string>;
  probeKvm?: (executable: string) => Promise<void>;
  probeDataDirectory?: (directory: string) => Promise<void>;
  getHardwareConcurrency?: () => number;
  getSystemMemoryInfo?: () => { total: number; available: number };
  getFileSystemStats?: (path: string) => Promise<{ bavail: bigint; bsize: bigint }>;
  fetch?: typeof fetch;
}

export interface CheckpointCandidateCapacityReport {
  ok: boolean;
  diskFreeMiB: number;
  candidateSizeMiB: number;
  errors: string[];
}

export interface CheckCheckpointCandidateCapacityOptions {
  workingDirectory: string;
  rootfsPath: string;
  inspectFile?: (path: string) => Promise<{ size: number; isFile: boolean }>;
  getFileSystemStats?: (path: string) => Promise<{ bavail: bigint; bsize: bigint }>;
}

export async function checkRunnerPrerequisites(
  options: CheckPrerequisitesOptions = {},
): Promise<PrerequisiteReport> {
  const platform = options.platform ?? Deno.build.os;
  const architecture = normalizeArchitecture(options.architecture ?? Deno.build.arch);
  const kernelRelease = options.kernelRelease ?? Deno.osRelease();
  const denoVersion = options.denoVersion ?? Deno.version.deno;
  const detectedLibc = options.libc === undefined
    ? await detectLibc(platform, architecture)
    : { libc: options.libc, glibcVersion: options.glibcVersion };
  const libc = options.libc ?? detectedLibc.libc;
  const glibcVersion = options.glibcVersion ??
    (libc === "glibc" ? detectedLibc.glibcVersion : undefined);
  const workingDirectory = options.workingDirectory ?? Deno.cwd();
  const probeExecutable = options.probeExecutable ?? probe;
  const probeKvm = options.probeKvm ?? probeKvmAcceleration;
  const probeDataDirectory = options.probeDataDirectory ?? probeWritableDirectory;
  const getHardwareConcurrency = options.getHardwareConcurrency ??
    (() => navigator.hardwareConcurrency);
  const getSystemMemoryInfo = options.getSystemMemoryInfo ?? Deno.systemMemoryInfo;
  const getFileSystemStats = options.getFileSystemStats ??
    ((path) => readFileSystemStats(path, { bigint: true }));
  const errors: string[] = [];
  const warnings: string[] = [];

  if (denoVersion !== REQUIRED_DENO_VERSION) {
    errors.push(
      `OpenOrb runner build requires Deno ${REQUIRED_DENO_VERSION} exactly; found ${denoVersion}. Rebuild with the pinned toolchain.`,
    );
  }

  if (!SUPPORTED_PLATFORMS.has(platform)) {
    errors.push(
      `Unsupported host platform "${platform}". OpenOrb runners target glibc Linux; only a temporary macOS development harness is available.`,
    );
  } else if (platform === "darwin") {
    warnings.push(
      "This is the temporary macOS development harness. macOS is not a supported runner release target.",
    );
  }

  if (!SUPPORTED_ARCHITECTURES.has(architecture)) {
    errors.push(
      `Unsupported host architecture "${architecture}". OpenOrb runners require x64 or arm64.`,
    );
  }
  if (!kernelRelease.trim()) errors.push("The host kernel release could not be determined.");

  if (platform === "linux" && libc === "musl") {
    errors.push(
      "Unsupported Linux C library: musl. Use a glibc-based x86-64 or ARM64 distribution and the matching official OpenOrb GNU/Linux artifact; Alpine Linux is not supported.",
    );
  } else if (platform === "linux" && libc === "unknown") {
    errors.push(
      "Unable to confirm the Linux C library. OpenOrb MVP runner executables support glibc only; Alpine Linux and other musl/gcompat hosts are unsupported.",
    );
  } else if (platform === "linux" && libc === "glibc") {
    if (!glibcVersion || !/^\d+(?:\.\d+)+$/.test(glibcVersion)) {
      errors.push("Unable to determine the host glibc version; glibc 2.27 or newer is required.");
    } else if (compareVersions(glibcVersion, MINIMUM_GLIBC_VERSION) < 0) {
      errors.push(
        `Unsupported glibc ${glibcVersion}. OpenOrb requires glibc ${MINIMUM_GLIBC_VERSION} or newer.`,
      );
    }
  }

  let qemu: ExecutableReport | undefined;
  let qemuImg: ExecutableReport | undefined;
  let kvm: PrerequisiteReport["kvm"];
  if (SUPPORTED_PLATFORMS.has(platform) && SUPPORTED_ARCHITECTURES.has(architecture)) {
    const qemuExecutable = architecture === "arm64" ? "qemu-system-aarch64" : "qemu-system-x86_64";
    qemu = await inspectExecutable(
      qemuExecutable,
      ["--version"],
      probeExecutable,
      qemuError(platform, qemuExecutable),
      errors,
    );
    qemuImg = await inspectExecutable(
      "qemu-img",
      ["--version"],
      probeExecutable,
      qemuImgError(platform),
      errors,
    );

    if (platform === "linux") {
      kvm = await inspectKvm(qemuExecutable, probeKvm, errors);
    }
  }

  const cpuCount = getHardwareConcurrency();
  const memory = getSystemMemoryInfo();
  const fileSystem = await getFileSystemStats(workingDirectory);
  const resources = {
    cpuCount,
    memoryTotalMiB: toMiB(memory.total),
    memoryAvailableMiB: toMiB(memory.available),
    diskFreeMiB: toSafeMiB(fileSystem.bavail * fileSystem.bsize),
  };
  if (!Number.isSafeInteger(cpuCount) || cpuCount < 1) {
    errors.push("No usable host CPU was detected.");
  }
  if (resources.memoryTotalMiB < 2 * 1024) {
    errors.push(
      `Only ${resources.memoryTotalMiB} MiB of host memory was detected; the smallest OpenOrb VM requires 2048 MiB.`,
    );
  }

  const dataDirectoryWritable = await inspectDataDirectory(
    workingDirectory,
    probeDataDirectory,
    errors,
  );
  const dataDirectory = { path: workingDirectory, writable: dataDirectoryWritable };

  let gateway: PrerequisiteReport["gateway"];
  if (options.gatewayUrl) {
    gateway = await inspectGateway(options.gatewayUrl, options.fetch ?? fetch, errors);
  }

  return {
    ok: errors.length === 0,
    platform,
    architecture,
    kernelRelease,
    denoVersion,
    libc,
    glibcVersion,
    qemu,
    qemuImg,
    kvm,
    resources,
    dataDirectory,
    gateway,
    errors,
    warnings,
  };
}

export async function checkCheckpointCandidateCapacity(
  options: CheckCheckpointCandidateCapacityOptions,
): Promise<CheckpointCandidateCapacityReport> {
  const inspectFile = options.inspectFile ?? (async (path) => {
    const info = await Deno.lstat(path);
    return { size: info.size, isFile: info.isFile && !info.isSymlink };
  });
  const getFileSystemStats = options.getFileSystemStats ??
    ((path: string) => readFileSystemStats(path, { bigint: true }));
  const rootfs = await inspectFile(options.rootfsPath);
  const fileSystem = await getFileSystemStats(options.workingDirectory);
  const diskFreeMiB = toSafeMiB(fileSystem.bavail * fileSystem.bsize);
  const candidateSizeMiB = Math.ceil(rootfs.size / MIB_BYTES);
  const errors: string[] = [];
  if (!rootfs.isFile) {
    errors.push("The verified guest root filesystem is not a regular file.");
  } else if (diskFreeMiB < candidateSizeMiB) {
    errors.push(
      `Runner data directory has ${diskFreeMiB} MiB free, but a checkpoint candidate may require ${candidateSizeMiB} MiB. Free disk space before starting the runner.`,
    );
  }
  return { ok: errors.length === 0, diskFreeMiB, candidateSizeMiB, errors };
}

async function inspectExecutable(
  executable: string,
  args: string[],
  probeExecutable: (executable: string, args: string[]) => Promise<string>,
  unavailableMessage: string,
  errors: string[],
): Promise<ExecutableReport | undefined> {
  const [output, error] = await tryAsync(
    Promise.resolve().then(() => probeExecutable(executable, args)),
    (cause) => new RunnerPrerequisiteProbeError(`Could not probe ${executable}.`, cause),
  );
  if (error !== undefined) {
    errors.push(`${unavailableMessage}${errorReason(error)}`);
    return undefined;
  }
  return {
    executable,
    version: output.split(/\r?\n/, 1)[0]?.trim() || "version unavailable",
  };
}

async function inspectKvm(
  qemuExecutable: string,
  probeKvm: (executable: string) => Promise<void>,
  errors: string[],
): Promise<PrerequisiteReport["kvm"]> {
  const [, error] = await tryAsync(
    probeKvm(qemuExecutable),
    (cause) =>
      new RunnerPrerequisiteProbeError(
        `Could not initialize KVM through ${qemuExecutable}.`,
        cause,
      ),
  );
  if (error !== undefined) {
    errors.push(kvmAccessError(error));
    return undefined;
  }
  return { device: KVM_DEVICE, accessible: true };
}

async function inspectDataDirectory(
  workingDirectory: string,
  probeDataDirectory: (directory: string) => Promise<void>,
  errors: string[],
): Promise<boolean> {
  const [, error] = await tryAsync(
    probeDataDirectory(workingDirectory),
    (cause) =>
      new RunnerPrerequisiteProbeError("Could not write the runner data directory.", cause),
  );
  if (error !== undefined) {
    errors.push(
      `Runner data directory ${workingDirectory} is not writable. Ensure it is owned by the runner service user with mode 0700.`,
    );
    return false;
  }
  return true;
}

async function inspectGateway(
  gatewayUrl: string,
  fetchImplementation: typeof fetch,
  errors: string[],
): Promise<PrerequisiteReport["gateway"]> {
  const [gateway, error] = await tryAsync(
    probeGateway(gatewayUrl, fetchImplementation),
    (cause) => new RunnerPrerequisiteProbeError("Could not reach the OpenOrb gateway.", cause),
  );
  if (error !== undefined) {
    errors.push(
      `OpenOrb gateway ${gatewayUrl} is unreachable or unhealthy. Verify the URL, TLS trust, DNS, and outbound HTTPS access.`,
    );
    return undefined;
  }
  return gateway;
}

class RunnerPrerequisiteProbeError extends Error {
  constructor(message: string, override readonly cause: unknown) {
    super(message, { cause });
    this.name = "RunnerPrerequisiteProbeError";
  }
}

async function probe(executable: string, args: string[]): Promise<string> {
  const command = new Deno.Command(executable, {
    args,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  });
  const output = await command.output();
  if (!output.success) {
    const message = new TextDecoder().decode(output.stderr).trim();
    throw new RunnerPrerequisiteProbeError(
      message || `${executable} exited with status ${output.code}.`,
      undefined,
    );
  }
  return new TextDecoder().decode(output.stdout);
}

async function probeKvmAcceleration(executable: string): Promise<void> {
  const command = new Deno.Command(executable, {
    args: [
      "-accel",
      "kvm",
      "-machine",
      "none",
      "-nodefaults",
      "-display",
      "none",
      "-S",
      "-qmp",
      "stdio",
    ],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  });
  await using child = command.spawn();
  const writer = child.stdin.getWriter();
  await writer.write(new TextEncoder().encode(QMP_QUIT_COMMANDS));
  await writer.close();
  const output = await child.output();
  if (!output.success) {
    const message = new TextDecoder().decode(output.stderr).trim();
    throw new RunnerPrerequisiteProbeError(
      message || `${executable} could not initialize KVM (status ${output.code}).`,
      undefined,
    );
  }
}

async function probeWritableDirectory(directory: string): Promise<void> {
  const path = `${directory}/.openorb-doctor-${crypto.randomUUID()}`;
  await using cleanup = new AsyncDisposableStack();
  cleanup.defer(async () => {
    await Deno.remove(path).catch((cause) => {
      if (!(cause instanceof Deno.errors.NotFound)) throw cause;
    });
  });
  await Deno.writeTextFile(path, "", { createNew: true, mode: 0o600 });
  if (Deno.build.os !== "windows") await Deno.chmod(path, 0o600);
}

async function probeGateway(
  gatewayUrl: string,
  fetchImplementation: typeof fetch,
): Promise<NonNullable<PrerequisiteReport["gateway"]>> {
  const healthUrl = new URL("/healthz", gatewayUrl);
  const response = await fetchImplementation(healthUrl, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(GATEWAY_TIMEOUT_MS),
  });
  const body = parse(gatewayHealthSchema, await response.json());
  if (!response.ok || body.service !== "openorb-gateway" || body.status !== "ok") {
    throw new RunnerPrerequisiteProbeError(
      `Gateway health check returned HTTP ${response.status}.`,
      undefined,
    );
  }
  return { url: gatewayUrl, healthUrl: healthUrl.href, status: response.status };
}

function normalizeArchitecture(value: string): string {
  if (value === "aarch64") return "arm64";
  if (value === "x86_64") return "x64";
  return value;
}

async function detectLibc(
  platform: RunnerPlatform,
  architecture: string,
): Promise<DetectedLibc> {
  if (platform !== "linux") return { libc: undefined, glibcVersion: undefined };
  if (Deno.build.env === "musl") return { libc: "musl", glibcVersion: undefined };
  if (Deno.build.env !== "gnu" || !SUPPORTED_ARCHITECTURES.has(architecture)) {
    return { libc: "unknown", glibcVersion: undefined };
  }

  const paths = architecture === "arm64" ? GLIBC_PATHS.arm64 : GLIBC_PATHS.x64;
  for (const path of paths) {
    const [bytes, readError] = await tryAsync(
      Deno.readFile(path),
      (cause) => new RunnerPrerequisiteProbeError(`Could not inspect ${path}.`, cause),
    );
    if (readError !== undefined) continue;
    const versions = [...new TextDecoder("latin1").decode(bytes).matchAll(/GLIBC_(\d+(?:\.\d+)+)/g)]
      .map((match) => match[1]!);
    const glibcVersion = versions.sort(compareVersions).at(-1);
    if (glibcVersion) return { libc: "glibc", glibcVersion };
  }

  return { libc: "unknown", glibcVersion: undefined };
}

function qemuError(platform: RunnerPlatform, executable: string): string {
  const install = platform === "darwin"
    ? "Install it with `brew install qemu`"
    : executable === "qemu-system-aarch64"
    ? "Install it with `sudo apt install qemu-system-arm` on Debian/Ubuntu"
    : "Install it with `sudo apt install qemu-system-x86` on Debian/Ubuntu";
  return `QEMU is unavailable. ${install} and ensure \`${executable}\` is on PATH.`;
}

function qemuImgError(platform: RunnerPlatform): string {
  const install = platform === "darwin"
    ? "Install it with `brew install qemu`"
    : "Install the architecture-appropriate QEMU system package on Debian/Ubuntu";
  return `QEMU disk tooling is unavailable. ${install} and ensure \`qemu-img\` is on PATH.`;
}

function kvmAccessError(error: unknown): string {
  return "KVM acceleration is unavailable at /dev/kvm. Enable hardware virtualization, load the " +
    "host KVM modules, install QEMU/KVM, and grant the openorb-runner service user read/write " +
    `access through the kvm group.${errorReason(error)}`;
}

function errorReason(error: unknown): string {
  const cause = error instanceof RunnerPrerequisiteProbeError ? error.cause : error;
  const message = cause instanceof Error ? cause.message.trim() : "";
  return message ? ` ${message}` : "";
}

function toMiB(bytes: number): number {
  return Math.floor(bytes / MIB_BYTES);
}

function toSafeMiB(bytes: bigint): number {
  const value = bytes / MIB_BYTES_BIGINT;
  return Number(value > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : value);
}

function compareVersions(left: string, right: string): number {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}
