export const REQUIRED_DENO_VERSION = "2.9.5";
import { tryAsync } from "@openorb/result";
const SUPPORTED_ARCHITECTURES = new Set(["arm64", "x64"]);
const SUPPORTED_PLATFORMS = new Set(["darwin", "linux"]);

export type RunnerPlatform = "darwin" | "linux" | string;
export type RunnerLibc = "glibc" | "musl" | "unknown";

export interface PrerequisiteReport {
  ok: boolean;
  platform: RunnerPlatform;
  architecture: string;
  denoVersion: string;
  libc: RunnerLibc | undefined;
  qemu: {
    executable: string;
    version: string;
  } | undefined;
  errors: string[];
  warnings: string[];
}

export interface CheckPrerequisitesOptions {
  platform?: RunnerPlatform;
  architecture?: string;
  denoVersion?: string;
  libc?: RunnerLibc;
  probeExecutable?: (executable: string, args: string[]) => Promise<string>;
}

export async function checkRunnerPrerequisites(
  options: CheckPrerequisitesOptions = {},
): Promise<PrerequisiteReport> {
  const platform = options.platform ?? Deno.build.os;
  const architecture = normalizeArchitecture(options.architecture ?? Deno.build.arch);
  const denoVersion = options.denoVersion ?? Deno.version.deno;
  const libc = options.libc ?? detectCompiledLibc(platform);
  const probeExecutable = options.probeExecutable ?? probe;
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

  if (platform === "linux" && libc === "musl") {
    errors.push(
      "Unsupported Linux C library: musl. OpenOrb MVP runner executables require a glibc-based x86-64 or ARM64 distribution.",
    );
  } else if (platform === "linux" && libc === "unknown") {
    errors.push(
      "Unable to confirm the Linux C library. OpenOrb MVP runner executables support glibc only; use the official GNU-target artifact on a glibc host.",
    );
  }

  let qemu: PrerequisiteReport["qemu"];
  if (SUPPORTED_PLATFORMS.has(platform) && SUPPORTED_ARCHITECTURES.has(architecture)) {
    const executable = architecture === "arm64" ? "qemu-system-aarch64" : "qemu-system-x86_64";

    const [output, probeError] = await tryAsync(
      Promise.resolve().then(() => probeExecutable(executable, ["--version"])),
      (cause) =>
        new RunnerPrerequisiteProbeError(`Could not probe QEMU with ${executable}.`, cause),
    );
    if (probeError !== undefined) {
      errors.push(qemuError(platform, executable, probeError));
      return prerequisiteReport(platform, architecture, denoVersion, libc, qemu, errors, warnings);
    }
    qemu = {
      executable,
      version: output.split(/\r?\n/, 1)[0]?.trim() || "version unavailable",
    };
  }

  return prerequisiteReport(platform, architecture, denoVersion, libc, qemu, errors, warnings);
}

function prerequisiteReport(
  platform: RunnerPlatform,
  architecture: string,
  denoVersion: string,
  libc: RunnerLibc | undefined,
  qemu: PrerequisiteReport["qemu"],
  errors: string[],
  warnings: string[],
): PrerequisiteReport {
  return {
    ok: errors.length === 0,
    platform,
    architecture,
    denoVersion,
    libc,
    qemu,
    errors,
    warnings,
  };
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

function normalizeArchitecture(value: string): string {
  if (value === "aarch64") return "arm64";
  if (value === "x86_64") return "x64";
  return value;
}

function detectCompiledLibc(platform: RunnerPlatform): RunnerLibc | undefined {
  if (platform !== "linux") return undefined;
  if (Deno.build.env === "gnu") return "glibc";
  if (Deno.build.env === "musl") return "musl";
  return "unknown";
}

function qemuError(platform: RunnerPlatform, executable: string, error: unknown): string {
  const install = platform === "darwin"
    ? "`brew install qemu`"
    : executable === "qemu-system-aarch64"
    ? "`sudo apt install qemu-system-arm`"
    : "`sudo apt install qemu-system-x86`";
  const reason = error instanceof Error && error.message ? ` ${error.message}` : "";

  return `QEMU is unavailable. Install it with ${install} and ensure \`${executable}\` is on PATH.${reason}`;
}
