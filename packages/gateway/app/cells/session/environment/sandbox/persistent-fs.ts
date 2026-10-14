import {
  type CpOptions,
  type CreateExclusiveOptions,
  type FileContent,
  InMemoryFs,
  type MkdirOptions,
  type RmOptions,
} from "just-bash/browser";

type SqlBinding = string | number | Uint8Array | null;
type SqlValue = SqlBinding | bigint | ArrayBuffer;

/** The synchronous SQLite API of a Durable Object, as far as the sandbox uses it. */
export interface SandboxSql {
  exec(query: string, ...bindings: SqlBinding[]): SqlCursor;
}

/** Rows are read as the cursor is iterated, so a result is never held whole. */
interface SqlCursor extends Iterable<Record<string, SqlValue>> {
  toArray(): Record<string, SqlValue>[];
}

interface Entry {
  readonly path: string;
  readonly kind: "file" | "directory" | "symlink";
  readonly mode: number;
  readonly mtime: number;
  readonly target: string | null;
}

/**
 * Never persisted: just-bash recreates device and process files on every start, and /tmp is
 * temporary, as on a runner's tmpfs.
 */
const EPHEMERAL = ["/dev", "/proc", "/tmp"];
/** celld rejects SQLite values of about 2 MB and more, so file contents are stored in chunks. */
const CHUNK_BYTES = 1024 * 1024;
/** Appends add rows of their own; past this many short rows, a file's tail is rewritten. */
const MAX_SHORT_CHUNKS = 64;

/**
 * just-bash's in-memory filesystem, written through to the facet's private SQLite database so the
 * workspace survives eviction and Stop Session. Every mutation persists the resolved paths it
 * touched from the in-memory state, so just-bash keeps sole ownership of path, symlink, and quota
 * semantics; SQLite only mirrors them. Untrusted paths never leave the sandbox isolate.
 */
export class PersistentFs extends InMemoryFs {
  readonly #sql: SandboxSql;
  /** Roots of recursive operations in progress, each persisted once it finishes. */
  readonly #recursive: string[] = [];

  private constructor(sql: SandboxSql, maxTotalBytes: number) {
    super(undefined, { maxTotalBytes });
    this.#sql = sql;
  }

  static async open(sql: SandboxSql, maxTotalBytes: number): Promise<PersistentFs> {
    sql.exec(
      "CREATE TABLE IF NOT EXISTS sandbox_entries (path TEXT PRIMARY KEY, kind TEXT NOT NULL, mode INTEGER NOT NULL, mtime REAL NOT NULL, target TEXT)",
    );
    sql.exec(
      "CREATE TABLE IF NOT EXISTS sandbox_chunks (path TEXT NOT NULL, chunk INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY (path, chunk))",
    );
    const fs = new PersistentFs(sql, maxTotalBytes);
    // One pass in path order: parents come before their children, and a file's chunks follow its
    // entry, so only one file's rows are held at a time.
    let file: { readonly entry: Entry; readonly chunks: Uint8Array[] } | undefined;
    for (const row of sql.exec(
      "SELECT e.*, c.data FROM sandbox_entries e LEFT JOIN sandbox_chunks c ON c.path = e.path ORDER BY e.path, c.chunk",
    )) {
      if (file?.entry.path !== String(row.path)) {
        if (file !== undefined) await fs.#restore(file.entry, file.chunks);
        file = { entry: entry(row), chunks: [] };
      }
      if (row.data !== null) file.chunks.push(bytes(row.data));
    }
    if (file !== undefined) await fs.#restore(file.entry, file.chunks);
    return fs;
  }

  override async writeFile(
    path: string,
    content: FileContent,
    options?: Parameters<InMemoryFs["writeFile"]>[2],
  ): Promise<void> {
    await super.writeFile(path, content, options);
    await this.#persist(await this.#followed(path), false);
  }

  override async appendFile(
    path: string,
    content: FileContent,
    options?: Parameters<InMemoryFs["appendFile"]>[2],
  ): Promise<void> {
    await super.appendFile(path, content, options);
    const resolved = await this.#followed(path);
    // just-bash opens every `>>` redirection with an empty append, which adds no bytes.
    if (content.length === 0) await this.#persistMetadata(resolved);
    else await this.#persistAppend(resolved);
  }

  override async mkdir(path: string, options?: MkdirOptions): Promise<void> {
    // `mkdir -p` of an existing directory changes nothing, so there is nothing to persist.
    const existed = await this.exists(path);
    await super.mkdir(path, options);
    if (!existed) await this.#persist(await this.#followed(path), false);
  }

  override async createExclusive(path: string, options: CreateExclusiveOptions): Promise<void> {
    await super.createExclusive(path, options);
    await this.#persist(await this.#unfollowed(path), false);
  }

  override async rm(path: string, options?: RmOptions): Promise<void> {
    const resolved = await this.#unfollowed(path);
    await this.#recursively([resolved], () => super.rm(path, options));
  }

  override async cp(src: string, dest: string, options?: CpOptions): Promise<void> {
    const resolved = await this.#unfollowed(dest);
    await this.#recursively([resolved], () => super.cp(src, dest, options));
  }

  override async mv(src: string, dest: string): Promise<void> {
    const roots = [await this.#unfollowed(src), await this.#unfollowed(dest)];
    await this.#recursively(roots, () => super.mv(src, dest));
  }

  override async chmod(path: string, mode: number): Promise<void> {
    await super.chmod(path, mode);
    await this.#persistMetadata(await this.#followed(path));
  }

  override async symlink(target: string, linkPath: string): Promise<void> {
    await super.symlink(target, linkPath);
    await this.#persist(await this.#unfollowed(linkPath), false);
  }

  override async link(existingPath: string, newPath: string): Promise<void> {
    await super.link(existingPath, newPath);
    await this.#persist(await this.#unfollowed(newPath), false);
  }

  override async utimes(path: string, atime: Date, mtime: Date): Promise<void> {
    await super.utimes(path, atime, mtime);
    await this.#persistMetadata(await this.#followed(path));
  }

  async #restore({ path, kind, mode, mtime, target }: Entry, chunks: readonly Uint8Array[]) {
    const time = new Date(mtime);
    if (kind === "file") {
      this.writeFileSync(path, concat(chunks), undefined, { mode, mtime: time });
    } else if (kind === "directory") {
      this.mkdirSync(path, { recursive: true });
      await InMemoryFs.prototype.chmod.call(this, path, mode);
      await InMemoryFs.prototype.utimes.call(this, path, time, time);
    } else {
      await InMemoryFs.prototype.symlink.call(this, target ?? "", path);
    }
  }

  /**
   * just-bash recurses through these same overrides, one call per entry. The nested calls leave
   * persisting to the outermost, which mirrors the final trees once, even after a failure part way.
   */
  async #recursively(roots: readonly string[], work: () => Promise<void>): Promise<void> {
    this.#recursive.push(...roots);
    await work().finally(async () => {
      for (const root of roots) this.#recursive.splice(this.#recursive.indexOf(root), 1);
      for (const root of roots) await this.#persist(root, true);
    });
  }

  /** Paths that are never persisted, or that a recursive operation in progress will persist. */
  #skipped(path: string): boolean {
    return ephemeral(path) || this.#recursive.some((root) => within(path, root));
  }

  /** The path with every symbolic link resolved, as operations that follow links see it. */
  async #followed(path: string): Promise<string> {
    const absolute = this.resolvePath("/", path);
    return (await this.exists(absolute))
      ? await this.realpath(absolute)
      : await this.#unfollowed(absolute);
  }

  /** The path with its directory resolved but its final component kept, for link operations. */
  async #unfollowed(path: string): Promise<string> {
    const absolute = this.resolvePath("/", path);
    if (absolute === "/") return absolute;
    const slash = absolute.lastIndexOf("/");
    const parent = await this.#followed(absolute.slice(0, slash) || "/");
    return this.resolvePath(parent, absolute.slice(slash + 1));
  }

  /**
   * Mirrors the in-memory state of `path`, and with `deep` everything below it, creating missing
   * ancestors. A path that no longer exists removes its rows.
   */
  async #persist(path: string, deep: boolean): Promise<void> {
    if (this.#skipped(path)) return;
    const exists = await this.#exists(path);
    // A surviving entry is replaced in place; only its old contents need deleting.
    const tables = deep || !exists ? ["sandbox_entries", "sandbox_chunks"] : ["sandbox_chunks"];
    const below = path === "/" ? "/" : `${path}/`;
    for (const table of tables) {
      this.#sql.exec(
        deep
          ? `DELETE FROM ${table} WHERE path = ? OR (path >= ? AND path < ?)`
          : `DELETE FROM ${table} WHERE path = ?`,
        ...(deep ? [path, below, `${below.slice(0, -1)}0`] : [path]),
      );
    }
    if (!exists) return;
    // Stored directories always have stored ancestors, so the walk stops at the first one.
    for (
      let parent = parentOf(path);
      parent !== "/" && !this.#stored(parent);
      parent = parentOf(parent)
    )
      await this.#save(parent);
    const directory = path === "/" || (await this.#save(path));
    if (!deep || !directory) return;
    // One ordered pass over every path, so parents come before their children. A path is saved
    // only below a saved directory, which skips anything reached through a symbolic link.
    const directories = new Set([path]);
    for (const child of this.getAllPaths()
      .filter((other) => other !== path && other.startsWith(below))
      .sort()) {
      if (ephemeral(child) || !directories.has(parentOf(child))) continue;
      if (await this.#save(child)) directories.add(child);
    }
  }

  /** Mode and time changes rewrite only the entry, never the file's contents. */
  async #persistMetadata(path: string): Promise<void> {
    if (this.#skipped(path)) return;
    const stat = await this.lstat(path);
    const updated = this.#sql
      .exec(
        "UPDATE sandbox_entries SET mode = ?, mtime = ? WHERE path = ? RETURNING path",
        stat.mode,
        stat.mtime.getTime(),
        path,
      )
      .toArray();
    if (updated.length === 0) await this.#persist(path, false);
  }

  /**
   * An append stores only the new bytes, as rows of their own. Once a file has more than
   * MAX_SHORT_CHUNKS rows shorter than a chunk, its rows from the first short one are rewritten as
   * whole chunks, so a log written line by line costs about one chunk per MAX_SHORT_CHUNKS lines.
   */
  async #persistAppend(path: string): Promise<void> {
    if (this.#skipped(path)) return;
    const [stored] = this.#sql
      .exec(
        `SELECT e.kind, COALESCE(SUM(length(c.data)), 0) AS bytes, COALESCE(MAX(c.chunk), -1) AS last,
        COALESCE(SUM(length(c.data) < ?), 0) AS short,
        MIN(CASE WHEN length(c.data) < ? THEN c.chunk END) AS firstShort
      FROM sandbox_entries e LEFT JOIN sandbox_chunks c ON c.path = e.path
      WHERE e.path = ? GROUP BY e.path`,
        CHUNK_BYTES,
        CHUNK_BYTES,
        path,
      )
      .toArray();
    const content = await this.readFileBuffer(path);
    const storedBytes = Number(stored?.bytes ?? 0);
    // Anything but an append to the stored file, such as one that replaced a link, is saved whole.
    if (stored?.kind !== "file" || content.byteLength < storedBytes) {
      return await this.#persist(path, false);
    }
    if (Number(stored.short) < MAX_SHORT_CHUNKS) {
      this.#insertChunks(path, content.subarray(storedBytes), Number(stored.last) + 1);
    } else {
      const first = Number(stored.firstShort);
      const [kept] = this.#sql
        .exec(
          "SELECT COALESCE(SUM(length(data)), 0) AS bytes FROM sandbox_chunks WHERE path = ? AND chunk < ?",
          path,
          first,
        )
        .toArray();
      this.#sql.exec("DELETE FROM sandbox_chunks WHERE path = ? AND chunk >= ?", path, first);
      this.#insertChunks(path, content.subarray(Number(kept?.bytes ?? 0)), first);
    }
    await this.#persistMetadata(path);
  }

  #stored(path: string): boolean {
    return (
      this.#sql.exec("SELECT 1 FROM sandbox_entries WHERE path = ?", path).toArray().length > 0
    );
  }

  async #exists(path: string): Promise<boolean> {
    return await this.lstat(path).then(
      () => true,
      () => false,
    );
  }

  /** Stores one entry, and a file's contents; true when it is a directory. */
  async #save(path: string): Promise<boolean> {
    const stat = await this.lstat(path);
    const metadata = { path, mode: stat.mode, mtime: stat.mtime.getTime() };
    if (stat.isSymbolicLink) {
      this.#insert({ ...metadata, kind: "symlink", target: await this.readlink(path) });
    } else if (stat.isDirectory) {
      this.#insert({ ...metadata, kind: "directory", target: null });
    } else {
      this.#insert({ ...metadata, kind: "file", target: null });
      this.#insertChunks(path, await this.readFileBuffer(path), 0);
    }
    return stat.isDirectory;
  }

  #insertChunks(path: string, content: Uint8Array, first: number): void {
    for (let offset = 0, chunk = first; offset < content.byteLength; offset += CHUNK_BYTES) {
      this.#sql.exec(
        "INSERT INTO sandbox_chunks (path, chunk, data) VALUES (?, ?, ?)",
        path,
        chunk++,
        content.subarray(offset, offset + CHUNK_BYTES),
      );
    }
  }

  #insert(entry: Entry): void {
    this.#sql.exec(
      "INSERT OR REPLACE INTO sandbox_entries (path, kind, mode, mtime, target) VALUES (?, ?, ?, ?, ?)",
      entry.path,
      entry.kind,
      entry.mode,
      entry.mtime,
      entry.target,
    );
  }
}

/** Whether `path` is `root` or below it. */
function within(path: string, root: string): boolean {
  return path === root || path.startsWith(root === "/" ? "/" : `${root}/`);
}

function ephemeral(path: string): boolean {
  return EPHEMERAL.some((root) => within(path, root));
}

function parentOf(path: string): string {
  return path.slice(0, path.lastIndexOf("/")) || "/";
}

function entry(row: Record<string, SqlValue>): Entry {
  return {
    path: String(row.path),
    kind: row.kind === "directory" || row.kind === "symlink" ? row.kind : "file",
    mode: Number(row.mode),
    mtime: Number(row.mtime),
    target: row.target === null ? null : String(row.target),
  };
}

function bytes(value: SqlValue | undefined): Uint8Array {
  if (value instanceof Uint8Array) return value;
  return value instanceof ArrayBuffer ? new Uint8Array(value) : new Uint8Array();
}

/** A file's chunks as one buffer; a file of one chunk keeps the row's own. */
function concat(chunks: readonly Uint8Array[]): Uint8Array {
  if (chunks.length === 1) return chunks[0]!;
  const joined = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined;
}
