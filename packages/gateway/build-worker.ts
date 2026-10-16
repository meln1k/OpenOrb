import { build } from "rolldown";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const gateway = fileURLToPath(new URL("./", import.meta.url));
const output = new URL("dist/", import.meta.url);
await mkdir(output, { recursive: true });
let sandboxCode = "";
let sandboxHash = "";

async function bundle(entry: string, destination: string) {
  await build({
    input: `${gateway}${entry}`,
    platform: "browser",
    external: [/^cloudflare:workers$/, /^node:/],
    plugins: [
      {
        name: "openorb-worker-inputs",
        resolveId(source) {
          // celld compiles the sibling WASM module; Rolldown bundles its JS wrapper only.
          if (source === "quickjs-wasi/quickjs.wasm") {
            return { id: "./quickjs.wasm", external: true };
          }
        },
        async load(id) {
          if (id.endsWith(".sql"))
            return `export default ${JSON.stringify(await readFile(id, "utf8"))};`;
          if (id.endsWith("/session/codemode-wasm.ts")) {
            return 'import wasm from "quickjs-wasi/quickjs.wasm";\nexport const loadCodemodeWasm = () => Promise.resolve(wasm);\n';
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
    },
  });
  await cp(
    new URL(import.meta.resolve("quickjs-wasi/quickjs.wasm")),
    new URL("quickjs.wasm", pathToFileURL(`${gateway}${destination}`)),
  );
}

if (process.argv.includes("--workspace-test")) {
  await bundle("test/workspace/celld-worker.ts", "test/workspace/dist/worker.js");
} else {
  // The sandbox runs in its own Worker Loader isolate; the gateway carries its bundle as a string.
  await bundle("../environments/src/sandbox/worker.ts", "dist/sandbox.js");
  sandboxCode = await readFile(new URL("sandbox.js", output), "utf8");
  sandboxHash = createHash("sha256").update(sandboxCode).digest("hex").slice(0, 16);
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
