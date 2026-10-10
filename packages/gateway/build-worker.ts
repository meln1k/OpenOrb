// Preserve Remix clientEntry source identities while producing a single Worker bundle.
const root = new URL("../../", import.meta.url);
const gateway = new URL("./", import.meta.url);
const output = new URL("dist/ssr/", gateway);
await Deno.mkdir(output, { recursive: true });
const absolute = (value: string, base: URL) =>
  value.startsWith(".") ? new URL(value, base).href : value;
const imports: Record<string, string> = {};
const scopes: Record<string, Record<string, string>> = {};
for (
  const directory of [
    "",
    "packages/gateway/",
    "packages/protocol/",
    "packages/result/",
  ]
) {
  const base = new URL(directory, root);
  const config = JSON.parse(await Deno.readTextFile(new URL("deno.json", base)));
  if (config.name) {
    // Deno config accepts both export forms; this is a checked-in build input.
    // deno-lint-ignore openorb/no-runtime-typeof
    const exports = typeof config.exports === "string" ? { ".": config.exports } : config.exports;
    for (const [key, value] of Object.entries(exports ?? {})) {
      imports[config.name + (key === "." ? "" : key.slice(1))] = absolute(String(value), base);
    }
  }
  const entries = Object.fromEntries(
    Object.entries(config.imports ?? {}).map(([key, value]) => [
      key.startsWith(".") ? new URL(key, base).href : key,
      absolute(String(value), base),
    ]),
  );
  if (directory) scopes[base.href] = entries;
  else Object.assign(imports, entries);
}
// Generated modules remain in the gateway's import-map scope.
async function preserveSources(directory: URL) {
  for await (const entry of Deno.readDir(directory)) {
    const source = new URL(entry.name + (entry.isDirectory ? "/" : ""), directory);
    if (entry.isDirectory) {
      await preserveSources(source);
      continue;
    }
    if (!/\.tsx?$/.test(entry.name) || entry.name.includes(".test.")) continue;
    let code = await Deno.readTextFile(source);
    const relative = source.href.slice(gateway.href.length);
    const target = new URL(relative, output);
    // Source modules are trusted build inputs, not user-supplied programs.
    code = code.replaceAll("import.meta.url", JSON.stringify(source.href))
      .replace(
        /((?:from\s*|import\s*\()\s*["'])(\.[^"']+)(["'])/g,
        (_match, start, path, end) => `${start}${new URL(path, source).href}${end}`,
      );
    await Deno.mkdir(new URL("./", target), { recursive: true });
    await Deno.writeTextFile(target, code);
    imports[source.href] = target.href;
  }
}
await preserveSources(new URL("app/", gateway));
// Bare @/ imports resolve only once; route them to the same generated graph as relative imports.
scopes[gateway.href]!["@/app/"] = new URL("app/", output).href;
const map = new URL("dist/worker-imports.json", gateway);
await Deno.writeTextFile(map, JSON.stringify({ imports, scopes }));
const config = new URL("dist/bundle-deno.json", gateway);
await Deno.writeTextFile(
  config,
  JSON.stringify({
    compilerOptions: { jsx: "react-jsx", jsxImportSource: "remix/component" },
    nodeModulesDir: "manual",
  }),
);
// The isolated build config prunes workspace metadata; retain the checked-in resolutions and
// integrity hashes in a disposable copy instead of rewriting the repository lockfile.
const lock = new URL("dist/bundle.lock", gateway);
await Deno.copyFile(new URL("deno.lock", root), lock);
const bundleOptions = [
  "bundle",
  "--frozen=false",
  `--lock=${lock.pathname}`,
  `--config=${config.pathname}`,
  "--platform=browser",
  // Remix infers client-entry export names from function.name during SSR.
  "--keep-names",
  "--external=cloudflare:workers",
  `--import-map=${map.pathname}`,
];
const command = new Deno.Command(Deno.execPath(), {
  args: [...bundleOptions, "server.ts", "-o", "dist/worker.js"],
  cwd: gateway.pathname,
  stdin: "null",
  stdout: "inherit",
  stderr: "inherit",
});
const result = await command.spawn().status;
if (!result.success) Deno.exit(result.code);
await Deno.writeTextFile(
  new URL("dist/worker.d.ts", gateway),
  'export * from "../server.ts"; export { default } from "../server.ts";\n',
);
async function copyTree(source: URL, target: URL): Promise<void> {
  await Deno.mkdir(target, { recursive: true });
  for await (const entry of Deno.readDir(source)) {
    const from = new URL(entry.name + (entry.isDirectory ? "/" : ""), source);
    const to = new URL(entry.name + (entry.isDirectory ? "/" : ""), target);
    if (entry.isDirectory) await copyTree(from, to);
    else await Deno.copyFile(from, to);
  }
}
if (Deno.args.includes("--test")) {
  const test = new Deno.Command(Deno.execPath(), {
    args: [...bundleOptions, "test/celld-worker.ts", "-o", "dist/test-worker.js"],
    cwd: gateway.pathname,
    stdin: "null",
    stdout: "inherit",
    stderr: "inherit",
  });
  const result = await test.spawn().status;
  if (!result.success) Deno.exit(result.code);
  const target = new URL("test/dist/", gateway);
  await Deno.mkdir(target, { recursive: true });
  await Deno.copyFile(new URL("dist/test-worker.js", gateway), new URL("worker.js", target));
  await copyTree(new URL("dist/assets/", gateway), new URL("assets/", target));
}
