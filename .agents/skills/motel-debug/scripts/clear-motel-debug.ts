import { extname, join, relative, resolve } from "node:path";

const START_MARKER = "#region motel debug";
const END_MARKER = "#endregion motel debug";
const DEFAULT_IGNORES = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  ".turbo",
  ".motel-data",
]);
const FILE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mts", ".cts"]);

if (Deno.args.includes("--help") || Deno.args.includes("-h")) {
  console.log(
    `Usage: deno run --allow-read --allow-write clear-motel-debug.ts [path]\n\nRemoves blocks wrapped in '${START_MARKER}' and '${END_MARKER}' from JS/TS files under the given path.`,
  );
  Deno.exit();
}

const root = resolve(Deno.args[0] ?? Deno.cwd());

async function* walk(directory: string): AsyncGenerator<string> {
  for await (const entry of Deno.readDir(directory)) {
    if (DEFAULT_IGNORES.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory) yield* walk(path);
    else if (entry.isFile && FILE_EXTENSIONS.has(extname(entry.name))) yield path;
  }
}

function cleanFile(filePath: string, source: string) {
  const kept: string[] = [];
  let depth = 0;
  let changed = false;

  for (const [index, line] of source.split(/\r?\n/).entries()) {
    if (line.includes(START_MARKER)) {
      depth += 1;
      changed = true;
      continue;
    }
    if (line.includes(END_MARKER)) {
      if (depth === 0) throw new Error(`Unmatched ${END_MARKER} in ${filePath}:${index + 1}`);
      depth -= 1;
      changed = true;
      continue;
    }
    if (depth === 0) kept.push(line);
    else changed = true;
  }

  if (depth !== 0) throw new Error(`Unmatched ${START_MARKER} in ${filePath}`);
  return { changed, content: kept.join("\n") };
}

const changedFiles: string[] = [];
for await (const filePath of walk(root)) {
  const source = await Deno.readTextFile(filePath);
  if (!source.includes(START_MARKER) && !source.includes(END_MARKER)) continue;
  const result = cleanFile(filePath, source);
  if (!result.changed) continue;
  await Deno.writeTextFile(filePath, result.content);
  changedFiles.push(relative(root, filePath) || filePath);
}

if (changedFiles.length === 0) {
  console.log(`No '${START_MARKER}' blocks found under ${root}`);
} else {
  console.log(`Removed Motel debug blocks from ${changedFiles.length} file(s):`);
  for (const file of changedFiles) console.log(`- ${file}`);
}
