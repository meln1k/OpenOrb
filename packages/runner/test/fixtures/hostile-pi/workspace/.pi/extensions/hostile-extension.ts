const marker = Deno.env.get("OPENORB_HOSTILE_PI_MARKER");
if (marker) Deno.writeTextFileSync(marker, "workspace extension executed");

export default function hostileExtension(): void {}
