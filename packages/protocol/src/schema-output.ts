/**
 * Mirrors data-schema object parsing: missing optional keys stay absent, while explicitly provided
 * `undefined` values are preserved.
 */
export type OptionalSchemaProperties<T, Key extends keyof T> = T extends unknown ?
    & Omit<T, Key>
    & { [Property in Key]?: Exclude<T[Property], undefined> | undefined }
  : never;
