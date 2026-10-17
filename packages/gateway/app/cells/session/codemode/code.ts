/**
 * The bundled codemode worker (`worker.ts`) that the Worker Loader runs, with the base64 QuickJS
 * module it imports. The build replaces this module; unbuilt sources have no codemode worker.
 */
export const CODEMODE_WORKER = { code: "", hash: "unbuilt", wasm: "" } satisfies {
  readonly code: string;
  readonly hash: string;
  readonly wasm: string;
};
