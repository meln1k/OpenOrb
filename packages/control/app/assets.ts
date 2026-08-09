import { createAssetServer } from "remix/assets";

const rootDir = Deno.realPathSync(new URL("../../../", import.meta.url));
const nodeEnv = Deno.env.get("NODE_ENV") ?? "development";
const isDevelopment = nodeEnv === "development";

export const assetServer = createAssetServer({
  basePath: "/assets",
  rootDir,
  fileMap: {
    "app/*path": "packages/control/app/*path",
  },
  allow: ["packages/control/app/assets/**"],
  sourceMaps: isDevelopment ? "external" : undefined,
  minify: !isDevelopment,
  watch: false,
});
