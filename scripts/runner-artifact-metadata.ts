const knownArtifacts = [
  {
    path: "dist/openorb-runner-linux-x64",
    machine: 62,
    architecture: "x86_64",
  },
  {
    path: "dist/openorb-runner-linux-arm64",
    machine: 183,
    architecture: "aarch64",
  },
] as const;
const systemdUnit = {
  source: "packages/runner/systemd/openorb-runner.service",
  path: "dist/openorb-runner.service",
} as const;

const requestedPaths = Deno.args.length > 0
  ? Deno.args
  : knownArtifacts.map((artifact) => artifact.path);
const artifacts = requestedPaths.map((path) => {
  const artifact = knownArtifacts.find((candidate) => candidate.path === path);
  if (!artifact) throw new Error(`Unknown runner artifact path: ${path}.`);
  return artifact;
});
if (new Set(requestedPaths).size !== requestedPaths.length) {
  throw new Error("Runner artifact paths must not be repeated.");
}

const checksumLines: string[] = [];
for (const artifact of artifacts) {
  const bytes = await Deno.readFile(artifact.path);
  verifyElf(bytes, artifact.machine, artifact.architecture);
  const checksum = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)).toHex();
  const glibcBaseline = findGlibcBaseline(bytes);
  if (compareVersions(glibcBaseline, "2.27") > 0) {
    throw new Error(
      `${artifact.path} requires glibc ${glibcBaseline}, newer than the approved MVP baseline 2.27.`,
    );
  }
  checksumLines.push(`${checksum}  ${artifact.path.replace("dist/", "")}`);
  console.log(
    JSON.stringify({
      artifact: artifact.path,
      architecture: artifact.architecture,
      sha256: checksum,
      minimumGlibc: glibcBaseline,
    }),
  );
}

if (Deno.args.length === 0) {
  await Deno.copyFile(systemdUnit.source, systemdUnit.path);
  const bytes = await Deno.readFile(systemdUnit.path);
  const checksum = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)).toHex();
  checksumLines.push(`${checksum}  ${systemdUnit.path.replace("dist/", "")}`);
  console.log(JSON.stringify({ artifact: systemdUnit.path, sha256: checksum }));
}

await Deno.writeTextFile("dist/SHA256SUMS", `${checksumLines.join("\n")}\n`);

function verifyElf(bytes: Uint8Array, expectedMachine: number, architecture: string): void {
  if (
    bytes.byteLength < 20 ||
    bytes[0] !== 0x7f ||
    bytes[1] !== 0x45 ||
    bytes[2] !== 0x4c ||
    bytes[3] !== 0x46 ||
    bytes[4] !== 2 ||
    bytes[5] !== 1
  ) {
    throw new Error(`Expected a 64-bit little-endian ELF artifact for ${architecture}.`);
  }
  const machine = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(
    18,
    true,
  );
  if (machine !== expectedMachine) {
    throw new Error(`ELF machine ${machine} does not match expected ${architecture}.`);
  }
}

function findGlibcBaseline(bytes: Uint8Array): string {
  const binaryText = new TextDecoder("latin1").decode(readElfSection(bytes, ".dynstr"));
  const versions = [...binaryText.matchAll(/GLIBC_(\d+\.\d+)/g)].map((match) => match[1]!);
  if (versions.length === 0) throw new Error("Runner artifact contains no glibc version symbols.");
  return versions.sort(compareVersions).at(-1)!;
}

function readElfSection(bytes: Uint8Array, expectedName: string): Uint8Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const sectionTableOffset = safeOffset(view.getBigUint64(40, true));
  const sectionEntrySize = view.getUint16(58, true);
  const sectionCount = view.getUint16(60, true);
  const sectionNamesIndex = view.getUint16(62, true);
  if (sectionEntrySize < 64 || sectionCount === 0 || sectionNamesIndex >= sectionCount) {
    throw new Error("Runner artifact has an invalid ELF section table.");
  }

  const sectionNamesHeader = sectionTableOffset + sectionNamesIndex * sectionEntrySize;
  const sectionNames = sectionBytes(bytes, view, sectionNamesHeader);
  for (let index = 0; index < sectionCount; index += 1) {
    const headerOffset = sectionTableOffset + index * sectionEntrySize;
    const nameOffset = view.getUint32(headerOffset, true);
    if (readNullTerminatedString(sectionNames, nameOffset) === expectedName) {
      return sectionBytes(bytes, view, headerOffset);
    }
  }
  throw new Error(`Runner artifact has no ${expectedName} ELF section.`);
}

function sectionBytes(bytes: Uint8Array, view: DataView, headerOffset: number): Uint8Array {
  if (headerOffset < 0 || headerOffset + 64 > bytes.byteLength) {
    throw new Error("Runner artifact has an ELF section header outside the file.");
  }
  const offset = safeOffset(view.getBigUint64(headerOffset + 24, true));
  const size = safeOffset(view.getBigUint64(headerOffset + 32, true));
  if (offset + size > bytes.byteLength) {
    throw new Error("Runner artifact has an ELF section outside the file.");
  }
  return bytes.subarray(offset, offset + size);
}

function readNullTerminatedString(bytes: Uint8Array, offset: number): string {
  if (offset >= bytes.byteLength) {
    throw new Error("Runner artifact has an invalid ELF section name.");
  }
  const end = bytes.indexOf(0, offset);
  if (end < 0) throw new Error("Runner artifact has an unterminated ELF section name.");
  return new TextDecoder("latin1").decode(bytes.subarray(offset, end));
}

function safeOffset(value: bigint): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new Error("Runner artifact has an unsupported ELF section offset.");
  }
  return number;
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
