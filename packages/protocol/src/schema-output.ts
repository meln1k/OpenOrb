export type OptionalSchemaProperties<T, Key extends keyof T> = T extends unknown ?
    & Omit<T, Key>
    & { [Property in Key]?: Exclude<T[Property], undefined> }
  : never;
