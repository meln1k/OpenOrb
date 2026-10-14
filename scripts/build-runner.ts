import { build } from "tsdown";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
process.chdir(root);
if (process.versions.node !== "26.11.1") {
  throw new Error("Runner releases must be built with Node 26.11.1.");
}
const architectures = process.argv.slice(2);
if (architectures.some((arch) => arch !== "x64" && arch !== "arm64")) {
  throw new Error("Expected x64 or arm64 build targets.");
}
await build({
  entry: ["packages/runner/src/standalone.ts"],
  outDir: "dist",
  clean: false,
  format: "esm",
  platform: "node",
  target: "node26",
  dts: false,
  // ssh2's embedded Poly1305 WASM uses CommonJS filename globals.
  // This is module-format compatibility, not a runtime permission shim.
  shims: true,
  deps: { alwaysBundle: [/.*/] },
  plugins: [
    {
      name: "standalone-optional-native-acceleration",
      resolveId(id) {
        // These dependencies are explicitly optional in ssh2/ws. Their guarded
        // requires fall back to native Node crypto and pure JS, on both targets.
        if (
          [
            "cpu-features",
            "bufferutil",
            "utf-8-validate",
            "./crypto/build/Release/sshcrypto.node",
          ].includes(id)
        ) {
          return `\0optional-native:${encodeURIComponent(id)}.js`;
        }
        return null;
      },
      load(id) {
        if (id.startsWith("\0optional-native:")) {
          return 'throw new Error("Optional native acceleration is disabled in standalone runners.");';
        }
        return null;
      },
      transform(code, id) {
        const vfsRoot = "/@earendil-works/gondolin/dist/src/vfs/node/vendored-node-vfs/lib/";
        if (id.includes(vfsRoot) && !id.endsWith("/gondolin-shim.js")) {
          // Keep Gondolin's userland Node-internal adapters, but expose VFS
          // module edges statically instead of assigning the CommonJS require.
          return code
            .replace(
              "require = patchRequire(require);",
              "const internalRequire = patchRequire(require);",
            )
            .replace(/require\('internal\/vfs\/([^']+)'\)/g, (_match, module) => {
              const root = id.slice(0, id.indexOf(vfsRoot) + vfsRoot.length);
              return `require(${JSON.stringify(`${root}internal/vfs/${module}.js`)})`;
            })
            .replace(/require\('internal\//g, "internalRequire('internal/");
        }
        if (!id.endsWith("/@earendil-works/gondolin/dist/src/vfs/node/index.js")) return null;
        // Gondolin's createRequire hides this mandatory vendored module from the
        // bundler. Make it a static import so the SEA needs no adjacent files.
        const source = 'const nodeVfs = require("./vendored-node-vfs/lib/vfs.js");';
        if (!code.includes(source)) throw new Error("Gondolin's vendored VFS entry changed.");
        return code.replace(source, 'import nodeVfs from "./vendored-node-vfs/lib/vfs.js";');
      },
    },
  ],
  exe: {
    fileName: "openorb-runner",
    outDir: "dist",
    targets: (architectures.length ? architectures : ["x64", "arm64"]).map((arch) => ({
      platform: "linux" as const,
      // SAFETY: the argument check above rejects every architecture except x64 and arm64; defaults use the same pair.
      arch: arch as "x64" | "arm64",
      nodeVersion: "26.11.1",
    })),
    seaConfig: {
      useCodeCache: false,
      useSnapshot: false,
      execArgvExtension: "none",
    },
  },
});
