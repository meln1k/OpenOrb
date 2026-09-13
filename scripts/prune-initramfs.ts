import { basename, dirname, join, posix } from "node:path";

const MODULE_FILE_SUFFIXES = [".ko", ".ko.gz", ".ko.xz", ".ko.zst"] as const;

export const REQUIRED_INITRAMFS_MODULES = [
  "af_packet",
  "virtio_blk",
  "virtio_console",
  "virtio_mmio",
  "virtio_pci",
  "virtio_rng",
  "virtio_net",
  "ext4",
  "fuse",
] as const;

export interface InitramfsPruneResult {
  readonly bytesBefore: number;
  readonly bytesAfter: number;
  readonly moduleBytesBefore: number;
  readonly moduleBytesAfter: number;
  readonly moduleFilesBefore: number;
  readonly moduleFilesAfter: number;
  readonly removedBootBytes: number;
}

export async function pruneInitramfsRoot(
  initramfsRoot: string,
): Promise<InitramfsPruneResult> {
  const bytesBefore = await treeSize(initramfsRoot);
  const bootDirectory = join(initramfsRoot, "boot");
  const removedBootBytes = await requiredTreeSize(bootDirectory);
  await Deno.remove(bootDirectory, { recursive: true });

  const modulesBase = join(initramfsRoot, "lib", "modules");
  const versions = await kernelVersions(modulesBase);
  if (versions.length === 0) {
    throw new Error(`The initramfs contains no kernel module trees under ${modulesBase}.`);
  }

  let moduleBytesBefore = 0;
  let moduleBytesAfter = 0;
  let moduleFilesBefore = 0;
  let moduleFilesAfter = 0;
  for (const version of versions) {
    const versionDirectory = join(modulesBase, version);
    const before = await moduleStats(versionDirectory);
    moduleBytesBefore += before.bytes;
    moduleFilesBefore += before.files;

    const requiredPaths = await resolveRequiredModulePaths(versionDirectory);
    for (const modulePath of await listModuleFiles(versionDirectory)) {
      if (!requiredPaths.has(modulePath)) {
        await Deno.remove(join(versionDirectory, ...modulePath.split("/")));
      }
    }
    await removeEmptyDirectories(join(versionDirectory, "kernel"));

    const vmlinuzLink = join(versionDirectory, "vmlinuz");
    try {
      await Deno.remove(vmlinuzLink);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }

    await regenerateModuleMetadata(initramfsRoot, version);
    const after = await moduleStats(versionDirectory);
    moduleBytesAfter += after.bytes;
    moduleFilesAfter += after.files;
  }

  return {
    bytesBefore,
    bytesAfter: await treeSize(initramfsRoot),
    moduleBytesBefore,
    moduleBytesAfter,
    moduleFilesBefore,
    moduleFilesAfter,
    removedBootBytes,
  };
}

export async function resolveRequiredModulePaths(
  versionDirectory: string,
  requiredModules: readonly string[] = REQUIRED_INITRAMFS_MODULES,
): Promise<ReadonlySet<string>> {
  const dependencies = await readModuleDependencies(versionDirectory);
  const modulePathsByName = await indexModulePathsByName(versionDirectory, dependencies);
  const builtinModuleNames = await readBuiltinModuleNames(versionDirectory);
  const pending: string[] = [];

  for (const moduleName of requiredModules) {
    const normalizedName = normalizeModuleName(moduleName);
    const modulePath = modulePathsByName.get(normalizedName);
    if (modulePath !== undefined) {
      pending.push(modulePath);
    } else if (!builtinModuleNames.has(normalizedName)) {
      throw new Error(
        `Required kernel module "${moduleName}" was not found in ${versionDirectory}.`,
      );
    }
  }

  const requiredPaths = new Set<string>();
  while (pending.length > 0) {
    const modulePath = pending.pop()!;
    if (requiredPaths.has(modulePath)) continue;
    requiredPaths.add(modulePath);
    for (const dependencyPath of dependencies.get(modulePath) ?? []) {
      const resolvedPath = modulePathsByName.get(
        normalizeModuleName(moduleNameFromPath(dependencyPath)),
      );
      if (resolvedPath !== undefined) {
        pending.push(resolvedPath);
      } else if (
        !builtinModuleNames.has(normalizeModuleName(moduleNameFromPath(dependencyPath)))
      ) {
        throw new Error(
          `Kernel module dependency "${dependencyPath}" referenced by "${modulePath}" ` +
            `was not found in ${versionDirectory}.`,
        );
      }
    }
  }
  return requiredPaths;
}

export async function repackInitramfs(
  initramfsRoot: string,
  destination: string,
): Promise<void> {
  const temporaryCpio = await Deno.makeTempFile({
    dir: dirname(destination),
    prefix: ".openorb-initramfs-",
    suffix: ".cpio",
  });
  const temporaryLz4 = await Deno.makeTempFile({
    dir: dirname(destination),
    prefix: ".openorb-initramfs-",
    suffix: ".cpio.lz4",
  });
  await using cleanup = new AsyncDisposableStack();
  cleanup.defer(async () => {
    for (const path of [temporaryCpio, temporaryLz4]) {
      await Deno.remove(path).catch((cause) => {
        if (!(cause instanceof Deno.errors.NotFound)) throw cause;
      });
    }
  });
  await runShell(
    [initramfsRoot, temporaryCpio, temporaryLz4],
    'cd "$1"\nfind . -print0 | cpio --null --create --format=newc --quiet > "$2"\nlz4 -l -c "$2" > "$3"',
    "The pruned initramfs could not be packed.",
  );
  await Deno.rename(temporaryLz4, destination);
}

async function regenerateModuleMetadata(initramfsRoot: string, version: string): Promise<void> {
  const loaders = [];
  for await (const entry of Deno.readDir(join(initramfsRoot, "lib"))) {
    if (
      entry.isFile && entry.name.startsWith("ld-musl-") && entry.name.endsWith(".so.1")
    ) {
      loaders.push(join(initramfsRoot, "lib", entry.name));
    }
  }
  if (loaders.length !== 1) {
    throw new Error(
      `Expected one Alpine musl loader in the initramfs, found ${loaders.length}.`,
    );
  }
  await runShell(
    [
      loaders[0]!,
      join(initramfsRoot, "usr", "lib"),
      join(initramfsRoot, "bin", "kmod"),
      initramfsRoot,
      version,
    ],
    'exec "$1" --argv0 /sbin/depmod --library-path "$2" "$3" -b "$4" -a "$5"',
    `Alpine depmod failed for kernel ${version}.`,
  );
}

async function runShell(
  arguments_: readonly string[],
  script: string,
  message: string,
): Promise<void> {
  const output = await new Deno.Command("sh", {
    args: ["-c", `set -eu\n${script}`, "openorb-initramfs", ...arguments_],
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (output.success) return;
  const stderr = new TextDecoder().decode(output.stderr).trim();
  throw new Error(`${message}${stderr ? `\n${stderr}` : ""}`);
}

async function readModuleDependencies(
  versionDirectory: string,
): Promise<ReadonlyMap<string, readonly string[]>> {
  const dependencies = new Map<string, readonly string[]>();
  const contents = await Deno.readTextFile(join(versionDirectory, "modules.dep"));
  for (const line of contents.split("\n")) {
    const separator = line.indexOf(":");
    if (separator === -1) continue;
    const modulePath = normalizeModulePath(line.slice(0, separator));
    if (!modulePath) continue;
    dependencies.set(
      modulePath,
      line.slice(separator + 1).trim().split(/\s+/u).filter(Boolean).map(normalizeModulePath),
    );
  }
  return dependencies;
}

async function readBuiltinModuleNames(versionDirectory: string): Promise<ReadonlySet<string>> {
  const names = new Set<string>();
  const contents = await Deno.readTextFile(join(versionDirectory, "modules.builtin"));
  for (const modulePath of contents.split("\n")) {
    if (modulePath.trim()) names.add(normalizeModuleName(moduleNameFromPath(modulePath)));
  }
  return names;
}

async function indexModulePathsByName(
  versionDirectory: string,
  dependencies: ReadonlyMap<string, readonly string[]>,
): Promise<ReadonlyMap<string, string>> {
  const pathsByName = new Map<string, Set<string>>();
  const add = (modulePath: string) => {
    const normalizedPath = normalizeModulePath(modulePath);
    const name = normalizeModuleName(moduleNameFromPath(normalizedPath));
    const paths = pathsByName.get(name) ?? new Set<string>();
    paths.add(normalizedPath);
    pathsByName.set(name, paths);
  };
  for (const [modulePath, dependencyPaths] of dependencies) {
    add(modulePath);
    dependencyPaths.forEach(add);
  }
  (await listModuleFiles(versionDirectory)).forEach(add);

  const resolved = new Map<string, string>();
  for (const [name, paths] of pathsByName) {
    const candidates = [...paths].sort((left, right) => {
      const dependencyPreference = Number(!dependencies.has(left)) -
        Number(!dependencies.has(right));
      return dependencyPreference || moduleSuffixPriority(left) - moduleSuffixPriority(right) ||
        left.localeCompare(right);
    });
    if (candidates[0] !== undefined) resolved.set(name, candidates[0]);
  }
  return resolved;
}

async function kernelVersions(modulesBase: string): Promise<readonly string[]> {
  const versions: string[] = [];
  for await (const entry of Deno.readDir(modulesBase)) {
    if (entry.isDirectory) versions.push(entry.name);
  }
  return versions.sort();
}

async function listModuleFiles(directory: string, relativeDirectory = ""): Promise<string[]> {
  const modulePaths: string[] = [];
  const entries = [];
  for await (
    const entry of Deno.readDir(join(directory, ...relativeDirectory.split("/").filter(Boolean)))
  ) {
    entries.push(entry);
  }
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
    if (entry.isDirectory) {
      modulePaths.push(...await listModuleFiles(directory, relativePath));
    } else if (entry.isFile && isModuleFile(relativePath)) {
      modulePaths.push(relativePath);
    }
  }
  return modulePaths;
}

async function removeEmptyDirectories(directory: string): Promise<boolean> {
  let empty = true;
  try {
    for await (const entry of Deno.readDir(directory)) {
      if (entry.isDirectory) {
        if (!await removeEmptyDirectories(join(directory, entry.name))) empty = false;
      } else {
        empty = false;
      }
    }
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return true;
    throw error;
  }
  if (empty) await Deno.remove(directory);
  return empty;
}

async function moduleStats(versionDirectory: string): Promise<{ bytes: number; files: number }> {
  const modulePaths = await listModuleFiles(versionDirectory);
  let bytes = 0;
  for (const modulePath of modulePaths) {
    bytes += (await Deno.stat(join(versionDirectory, ...modulePath.split("/")))).size;
  }
  return { bytes, files: modulePaths.length };
}

async function requiredTreeSize(directory: string): Promise<number> {
  try {
    return await treeSize(directory);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      throw new Error(`Expected initramfs directory is missing: ${directory}.`, { cause: error });
    }
    throw error;
  }
}

async function treeSize(path: string): Promise<number> {
  const info = await Deno.lstat(path);
  if (info.isFile) return info.size;
  if (!info.isDirectory) return 0;
  let bytes = 0;
  for await (const entry of Deno.readDir(path)) bytes += await treeSize(join(path, entry.name));
  return bytes;
}

function isModuleFile(modulePath: string): boolean {
  return MODULE_FILE_SUFFIXES.some((suffix) => modulePath.endsWith(suffix));
}

function moduleSuffixPriority(modulePath: string): number {
  const priority = MODULE_FILE_SUFFIXES.findIndex((suffix) => modulePath.endsWith(suffix));
  return priority === -1 ? MODULE_FILE_SUFFIXES.length : priority;
}

function moduleNameFromPath(modulePath: string): string {
  const filename = posix.basename(normalizeModulePath(modulePath));
  const suffix = MODULE_FILE_SUFFIXES.find((candidate) => filename.endsWith(candidate));
  return suffix === undefined ? basename(filename) : filename.slice(0, -suffix.length);
}

function normalizeModulePath(modulePath: string): string {
  return modulePath.replaceAll("\\", "/").trim();
}

function normalizeModuleName(moduleName: string): string {
  return moduleName.replaceAll("-", "_");
}
