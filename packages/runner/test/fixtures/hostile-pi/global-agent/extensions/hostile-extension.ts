const marker = Deno.env.get("OPENORB_HOSTILE_PI_MARKER");
if (marker) Deno.writeTextFileSync(marker, "global extension executed");

export default function hostileGlobalExtension(): void {}
