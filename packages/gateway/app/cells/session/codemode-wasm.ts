// Unbundled tests use Pi's file loader. The gateway build replaces this module with a compiled
// WASM import; no filesystem loader enters the deployed Worker.
export { loadQuickJSWasm as loadCodemodeWasm } from "@earendil-works/pi-codemode";
