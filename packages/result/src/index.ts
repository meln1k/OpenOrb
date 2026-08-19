export type Result<T, E> =
  | readonly [T, undefined]
  | readonly [undefined, E];

export const ok = <T>(value: T): Result<T, never> => [value, undefined];

export const err = <E>(error: E): Result<never, E> => [undefined, error];

export async function tryAsync<T, E>(
  promise: Promise<T>,
  mapError: (cause: unknown) => E,
): Promise<Result<T, E>> {
  try {
    return ok(await promise);
  } catch (cause) {
    return err(mapError(cause));
  }
}

export function trySync<T, E>(
  fn: () => T,
  mapError: (cause: unknown) => E,
): Result<T, E> {
  try {
    return ok(fn());
  } catch (cause) {
    return err(mapError(cause));
  }
}
