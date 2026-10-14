// Lucide's individual ESM icon modules export IconNode arrays but ship no declarations.
declare module "lucide/dist/esm/icons/*.mjs" {
  const nodes: import("lucide").IconNode;
  export default nodes;
}
