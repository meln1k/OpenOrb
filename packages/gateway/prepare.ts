import { chmod, writeFile } from "node:fs/promises";

const key = process.env.OPENORB_MASTER_KEY;
if (!key || !/^(?:[a-fA-F0-9]{64}|[A-Za-z0-9+/]{43}=)$/.test(key)) {
  throw new Error("OPENORB_MASTER_KEY must be a 32-byte hex or base64 key.");
}
const secret = process.env.SESSION_SECRET;
if (!secret) throw new Error("SESSION_SECRET is required");
await writeFile(
  ".dev.vars",
  [
    `OPENORB_MASTER_KEY=${key}`,
    `SESSION_SECRET=${secret}`,
    `PUBLIC_URL=${process.env.PUBLIC_URL ?? ""}`,
    `OPENORB_SESSION_COOKIE_SECURE=${process.env.OPENORB_SESSION_COOKIE_SECURE ?? "false"}`,
  ].join("\n") + "\n",
  { mode: 0o600 },
);
await chmod(".dev.vars", 0o600);
