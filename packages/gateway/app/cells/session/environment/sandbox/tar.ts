import { type Command, defineCommand, type ResolvedCommandContext } from "just-bash/browser";
import { tryAsync } from "@openorb/result";
import { createTarDecoder } from "modern-tar";

const USAGE = "usage: tar -x[z]f ARCHIVE [-C DIRECTORY] [--strip-components=N]\n";

/**
 * Extract-only `tar` for inspecting untrusted archives, which just-bash's browser build lacks.
 * just-bash's archive limits apply before any entry is buffered.
 * Absolute names and `..` components are skipped, and the archive's symbolic links are created
 * only after every file, so no entry is written through a link from the same archive. As with GNU
 * tar, links that already exist below the target directory are followed.
 */
export const tarCommand: Command = defineCommand("tar", async (args, ctx) => {
  const options = parseArguments(args);
  if (options === undefined) return { stdout: "", stderr: USAGE, exitCode: 2 };
  const archive = ctx.fs.resolvePath(ctx.cwd, options.file);
  const directory = ctx.fs.resolvePath(ctx.cwd, options.directory);
  const [bytes, readFailure] = await tryAsync(ctx.fs.readFileBuffer(archive), message);
  if (readFailure !== undefined) {
    return { stdout: "", stderr: `tar: ${options.file}: ${readFailure}\n`, exitCode: 2 };
  }
  if (bytes.byteLength > ctx.limits.maxArchiveCompressedBytes) {
    return { stdout: "", stderr: `tar: ${options.file}: archive too large\n`, exitCode: 2 };
  }
  const [, extractFailure] = await tryAsync(
    extract(ctx, bytes, directory, options.strip, options.gzip || isGzip(bytes)),
    message,
  );
  if (extractFailure !== undefined) {
    return { stdout: "", stderr: `tar: ${extractFailure}\n`, exitCode: 2 };
  }
  return { stdout: "", stderr: "", exitCode: 0 };
});

interface TarOptions {
  readonly file: string;
  readonly directory: string;
  readonly strip: number;
  readonly gzip: boolean;
}

function parseArguments(args: readonly string[]): TarOptions | undefined {
  let extractMode = false;
  let gzip = false;
  let file: string | undefined;
  let directory = ".";
  let strip = 0;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg.startsWith("--strip-components=")) {
      strip = Number(arg.slice("--strip-components=".length));
      if (!Number.isSafeInteger(strip) || strip < 0) return undefined;
    } else if (arg === "-C" || arg === "--directory") {
      directory = args[++index] ?? "";
    } else if (/^-?[xzvf]+$/.test(arg)) {
      extractMode ||= arg.includes("x");
      gzip ||= arg.includes("z");
      if (arg.includes("f")) file = args[++index];
    } else {
      return undefined;
    }
  }
  return extractMode && file && directory ? { file, directory, strip, gzip } : undefined;
}

function isGzip(bytes: Uint8Array): boolean {
  return bytes[0] === 0x1f && bytes[1] === 0x8b;
}

async function extract(
  { fs, limits }: Pick<ResolvedCommandContext, "fs" | "limits">,
  bytes: Uint8Array,
  directory: string,
  strip: number,
  gzip: boolean,
): Promise<void> {
  let stream: ReadableStream<Uint8Array<ArrayBuffer>> = new Blob([bytes.slice()]).stream();
  if (gzip) stream = stream.pipeThrough(new DecompressionStream("gzip"));
  await fs.mkdir(directory, { recursive: true });
  const links: { readonly target: string; readonly path: string }[] = [];
  let entries = 0;
  let total = 0;
  for await (const entry of stream.pipeThrough(createTarDecoder({ strict: true }))) {
    total += entry.header.size;
    if (++entries > limits.maxArchiveEntries) throw new TarLimitError("too many entries");
    if (entry.header.size > limits.maxArchiveEntryBytes || total > limits.maxArchiveBytes) {
      throw new TarLimitError(`${entry.header.name}: archive too large`);
    }
    const name = entryPath(entry.header.name, strip);
    const type = entry.header.type ?? "file";
    if (name === undefined || (type !== "file" && type !== "directory" && type !== "symlink")) {
      await entry.body.cancel();
      continue;
    }
    const path = `${directory === "/" ? "" : directory}/${name}`;
    if (type !== "file") {
      await entry.body.cancel();
      if (type === "directory") await fs.mkdir(path, { recursive: true });
      else links.push({ target: entry.header.linkname ?? "", path });
      continue;
    }
    await fs.mkdir(path.slice(0, path.lastIndexOf("/")) || "/", { recursive: true });
    await fs.writeFile(path, new Uint8Array(await new Response(entry.body).arrayBuffer()));
    if (entry.header.mode !== undefined) await fs.chmod(path, entry.header.mode & 0o777);
  }
  for (const { target, path } of links) {
    await fs.mkdir(path.slice(0, path.lastIndexOf("/")) || "/", { recursive: true });
    await fs.rm(path, { force: true });
    await fs.symlink(target, path);
  }
}

class TarLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TarLimitError";
  }
}

/** The entry's path below the target directory, or undefined when it escapes or is stripped. */
function entryPath(name: string, strip: number): string | undefined {
  if (name.startsWith("/")) return undefined;
  const parts = name.split("/").filter((part) => part !== "" && part !== ".");
  if (parts.includes("..") || parts.length <= strip) return undefined;
  return parts.slice(strip).join("/");
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : "failed";
}
