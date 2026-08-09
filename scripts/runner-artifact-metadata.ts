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
  const binaryText = new TextDecoder("latin1").decode(bytes);
  const versions = [...binaryText.matchAll(/GLIBC_(\d+\.\d+)/g)].map((match) => match[1]!);
  if (versions.length === 0) throw new Error("Runner artifact contains no glibc version symbols.");
  return versions.sort(compareVersions).at(-1)!;
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
