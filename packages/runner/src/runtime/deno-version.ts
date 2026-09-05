export const MINIMUM_DENO_VERSION = "2.9.5";

/** Stable releases only; prerelease runtimes are not a supported deployment target. */
export function isSupportedDenoVersion(version: string): boolean {
  if (!/^\d+\.\d+\.\d+$/.test(version)) return false;
  const parts = version.split(".").map(Number);
  const minimum = MINIMUM_DENO_VERSION.split(".").map(Number);
  for (let index = 0; index < minimum.length; index += 1) {
    const difference = parts[index]! - minimum[index]!;
    if (difference !== 0) return difference > 0;
  }
  return true;
}
