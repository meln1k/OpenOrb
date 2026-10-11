// Node's POSIX path rules for the guest, without `node:path`: the daemon only runs on Linux.

/** Node's `normalizeString`: resolves `.` and `..` segments of `path`. */
function normalizeSegments(path: string, allowAboveRoot: boolean): string {
  const segments: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (segments.length > 0 && segments.at(-1) !== "..") segments.pop();
      else if (allowAboveRoot) segments.push("..");
      continue;
    }
    segments.push(segment);
  }
  return segments.join("/");
}

export function isAbsolute(path: string): boolean {
  return path.startsWith("/");
}

/** Node's `posix.normalize`. */
export function normalize(path: string): string {
  if (path === "") return ".";
  const absolute = isAbsolute(path);
  const trailing = path.endsWith("/");
  let normalized = normalizeSegments(path, !absolute);
  if (normalized === "" && !absolute) normalized = ".";
  if (normalized !== "" && trailing) normalized += "/";
  return absolute ? `/${normalized}` : normalized;
}

/** Node's `posix.join`. */
export function join(...parts: string[]): string {
  const joined = parts.filter((part) => part !== "").join("/");
  return joined === "" ? "." : normalize(joined);
}

/**
 * Node's `posix.resolve`, except that a result that would depend on the host process's working
 * directory is rejected: the first argument is always an absolute guest directory.
 */
export function resolve(...parts: string[]): string {
  let resolved = "";
  for (let index = parts.length - 1; index >= 0 && !isAbsolute(resolved); index--) {
    const part = parts[index]!;
    if (part === "") continue;
    resolved = resolved === "" ? part : `${part}/${resolved}`;
  }
  if (!isAbsolute(resolved)) throw new TypeError(`Cannot resolve relative guest path ${resolved}`);
  return `/${normalizeSegments(resolved, false)}`;
}

/** Node's `posix.basename` without a suffix argument. */
export function basename(path: string): string {
  let end = path.length;
  while (end > 1 && path[end - 1] === "/") end--;
  const trimmed = path.slice(0, end);
  if (trimmed === "/") return "";
  return trimmed.slice(trimmed.lastIndexOf("/") + 1);
}

/** Node's POSIX `fileURLToPath`. */
export function fileURLToPath(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "file:") throw new TypeError("The URL must be of scheme file");
  if (url.hostname !== "") throw new TypeError("File URL host must be empty on POSIX");
  if (/%2f/i.test(url.pathname)) {
    throw new TypeError("File URL path must not include encoded / characters");
  }
  return decodeURIComponent(url.pathname);
}

/** libuv's POSIX `readdir` order: names compared by their bytes. */
export function compareBytes(left: Uint8Array, right: Uint8Array): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index++) {
    const difference = left[index]! - right[index]!;
    if (difference !== 0) return difference;
  }
  return left.length - right.length;
}
