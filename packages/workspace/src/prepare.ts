const key = Deno.env.get("OPENORB_MASTER_KEY");
if (!key || !/^(?:[a-fA-F0-9]{64}|[A-Za-z0-9+/]{43}=)$/.test(key)) {
  throw new Error("OPENORB_MASTER_KEY must be a 32-byte hex or base64 key.");
}
await Deno.writeTextFile(".dev.vars", `OPENORB_MASTER_KEY=${key}\n`, { mode: 0o600 });
await Deno.chmod(".dev.vars", 0o600);
