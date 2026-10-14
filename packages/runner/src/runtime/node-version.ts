export const MINIMUM_NODE_VERSION = "26.11.1";

/** Stable releases only; prerelease runtimes are not a supported deployment target. */
export function isSupportedNodeVersion(version: string): boolean {
  if (!/^\d+\.\d+\.\d+$/.test(version)) return false;
  const parts = version.split(".").map(Number);
  const minimum = MINIMUM_NODE_VERSION.split(".").map(Number);
  for (let index = 0; index < minimum.length; index += 1) {
    const difference = parts[index]! - minimum[index]!;
    if (difference !== 0) return difference > 0;
  }
  return true;
}
