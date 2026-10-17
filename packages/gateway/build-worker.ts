import { build } from "rolldown";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const gateway = fileURLToPath(new URL("./", import.meta.url));
const output = new URL("dist/", import.meta.url);
await mkdir(output, { recursive: true });
const QUICKJS_WASM = "quickjs-wasi/quickjs.wasm";
let sandboxCode = "";
let sandboxHash = "";
let codemodeWorker = { code: "", hash: "unbuilt", wasm: "" };

async function bundle(entry: string, destination: string) {
  await build({
    input: `${gateway}${entry}`,
    platform: "browser",
    // The Worker Loader supplies QuickJS beside the codemode worker as a WebAssembly module.
    external: [/^cloudflare:workers$/, /^node:/, QUICKJS_WASM],
    plugins: [
      {
        name: "openorb-worker-inputs",
        async load(id) {
          if (id.endsWith(".sql"))
            return `export default ${JSON.stringify(await readFile(id, "utf8"))};`;
          if (id.endsWith("/session/codemode/code.ts")) {
            return `export const CODEMODE_WORKER = ${JSON.stringify(codemodeWorker)};`;
          }
          if (id.endsWith("/sandbox/code.ts")) {
            return `export const SANDBOX_WORKER = ${JSON.stringify({ code: sandboxCode, hash: sandboxHash })};`;
          }
        },
        transform(code, id) {
          // Remix clientEntry identifies browser modules by their original source URL.
          if (id.startsWith(`${gateway}app/`)) {
            return code.replaceAll("import.meta.url", JSON.stringify(pathToFileURL(id).href));
          }
        },
      },
    ],
    output: {
      file: `${gateway}${destination}`,
      format: "esm",
      keepNames: true,
      codeSplitting: false,
      paths: { [QUICKJS_WASM]: "./quickjs.wasm" },
    },
  });
}

if (process.argv.includes("--workspace-test")) {
  await bundle("test/workspace/celld-worker.ts", "test/workspace/dist/worker.js");
} else {
  // The sandbox runs in its own Worker Loader isolate; the gateway carries its bundle as a string.
  await bundle("../environments/src/sandbox/worker.ts", "dist/sandbox.js");
  sandboxCode = await readFile(new URL("sandbox.js", output), "utf8");
  sandboxHash = createHash("sha256").update(sandboxCode).digest("hex").slice(0, 16);
  // Codemode's VM runs in its own Worker Loader isolate too; the gateway carries QuickJS for it.
  await bundle("app/cells/session/codemode/worker.ts", "dist/codemode.js");
  const codemodeCode = await readFile(new URL("codemode.js", output), "utf8");
  const quickjs = await readFile(new URL(import.meta.resolve(QUICKJS_WASM)));
  codemodeWorker = {
    code: codemodeCode,
    hash: createHash("sha256").update(codemodeCode).update(quickjs).digest("hex").slice(0, 16),
    // celld's Worker Loader takes WebAssembly as bytes, not as a compiled module.
    wasm: quickjs.toString("base64"),
  };
  await bundle("server.ts", "dist/worker.js");
  await writeFile(
    new URL("worker.d.ts", output),
    'export * from "../server.ts"; export { default } from "../server.ts";\n',
  );
  if (process.argv.includes("--test")) {
    await bundle("test/celld-worker.ts", "test/dist/worker.js");
    await cp(new URL("assets/", output), new URL("test/dist/assets/", import.meta.url), {
      recursive: true,
    });
  }
}
