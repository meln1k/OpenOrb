const key = Deno.env.get("OPENORB_MASTER_KEY");
if (!key || !/^(?:[a-fA-F0-9]{64}|[A-Za-z0-9+/]{43}=)$/.test(key)) {
  throw new Error("OPENORB_MASTER_KEY must be a 32-byte hex or base64 key.");
}
const secret = Deno.env.get("SESSION_SECRET");
if (!secret) throw new Error("SESSION_SECRET is required");
await Deno.writeTextFile(
  ".dev.vars",
  [
    `OPENORB_MASTER_KEY=${key}`,
    `SESSION_SECRET=${secret}`,
    `PUBLIC_URL=${Deno.env.get("PUBLIC_URL") ?? ""}`,
    `OPENORB_SESSION_COOKIE_SECURE=${Deno.env.get("OPENORB_SESSION_COOKIE_SECURE") ?? "false"}`,
  ].join("\n") + "\n",
  { mode: 0o600 },
);
await Deno.chmod(".dev.vars", 0o600);
