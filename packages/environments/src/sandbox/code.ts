/**
 * The bundled sandbox worker (`worker.ts`) that the Worker Loader runs. The build replaces this
 * module with the bundle and its content hash; unbuilt sources have no sandbox code.
 */
export const SANDBOX_WORKER = { code: "", hash: "unbuilt" } satisfies {
  readonly code: string;
  readonly hash: string;
};
