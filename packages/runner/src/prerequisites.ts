import { execFile } from "node:child_process";

const MINIMUM_NODE_VERSION = "24.3.0";
const SUPPORTED_ARCHITECTURES = new Set(["arm64", "x64"]);
const SUPPORTED_PLATFORMS = new Set<NodeJS.Platform>(["darwin", "linux"]);

export interface PrerequisiteReport {
  ok: boolean;
  platform: NodeJS.Platform;
  architecture: string;
  nodeVersion: string;
  qemu?: {
    executable: string;
    version: string;
  };
  errors: string[];
  warnings: string[];
}

interface CheckPrerequisitesOptions {
  platform?: NodeJS.Platform;
  architecture?: string;
  nodeVersion?: string;
  probeExecutable?: (executable: string, args: string[]) => Promise<string>;
}

export async function checkRunnerPrerequisites(
  options: CheckPrerequisitesOptions = {},
): Promise<PrerequisiteReport> {
  let platform = options.platform ?? process.platform;
  let architecture = options.architecture ?? process.arch;
  let nodeVersion = options.nodeVersion ?? process.versions.node;
  let probeExecutable = options.probeExecutable ?? probe;
  let errors: string[] = [];
  let warnings: string[] = [];

  if (!isVersionAtLeast(nodeVersion, MINIMUM_NODE_VERSION)) {
    errors.push(
      `Node.js ${MINIMUM_NODE_VERSION} or newer is required; found ${nodeVersion}. Install a current Node.js 24 release.`,
    );
  }

  if (!SUPPORTED_PLATFORMS.has(platform)) {
    errors.push(
      `Unsupported host platform "${platform}". OpenOrb runners target Linux; only a temporary macOS development harness is available in OO-001.`,
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

  let qemu: PrerequisiteReport["qemu"];
  if (SUPPORTED_PLATFORMS.has(platform) && SUPPORTED_ARCHITECTURES.has(architecture)) {
    let executable = architecture === "arm64" ? "qemu-system-aarch64" : "qemu-system-x86_64";

    try {
      let output = await probeExecutable(executable, ["--version"]);
      qemu = {
        executable,
        version: output.split(/\r?\n/, 1)[0]?.trim() || "version unavailable",
      };
    } catch (error) {
      errors.push(qemuError(platform, executable, error));
    }
  }

  return {
    ok: errors.length === 0,
    platform,
    architecture,
    nodeVersion,
    qemu,
    errors,
    warnings,
  };
}

function probe(executable: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(executable, args, { encoding: "utf8" }, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(stdout);
    });
  });
}

function isVersionAtLeast(actual: string, minimum: string): boolean {
  let actualParts = parseVersion(actual);
  let minimumParts = parseVersion(minimum);
  if (!actualParts || !minimumParts) return false;

  for (let index = 0; index < minimumParts.length; index++) {
    let difference = actualParts[index]! - minimumParts[index]!;
    if (difference !== 0) return difference > 0;
  }

  return true;
}

function parseVersion(value: string): [number, number, number] | undefined {
  let match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(value);
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function qemuError(platform: NodeJS.Platform, executable: string, error: unknown): string {
  let install =
    platform === "darwin"
      ? "`brew install qemu`"
      : executable === "qemu-system-aarch64"
        ? "`sudo apt install qemu-system-arm`"
        : "`sudo apt install qemu-system-x86`";
  let errorCode = getErrorCode(error);
  let reason =
    errorCode && errorCode !== "ENOENT" ? ` The executable failed with ${errorCode}.` : "";

  return `QEMU is unavailable. Install it with ${install} and ensure \`${executable}\` is on PATH.${reason}`;
}

function getErrorCode(error: unknown): string | undefined {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return error.code;
  }
  return undefined;
}
