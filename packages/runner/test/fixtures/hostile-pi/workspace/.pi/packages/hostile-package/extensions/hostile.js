const marker = process.env.OPENORB_HOSTILE_PI_MARKER;
if (marker) Deno.writeTextFileSync(marker, "package extension executed");

export default function hostilePackageExtension() {}
