export const screens = {
  sm: "640px",
  md: "768px",
  lg: "1024px",
  xl: "1280px",
  "2xl": "1536px",
} as const;

export const media = {
  sm: `@media (min-width: ${screens.sm})`,
  md: `@media (min-width: ${screens.md})`,
  lg: `@media (min-width: ${screens.lg})`,
  xl: `@media (min-width: ${screens.xl})`,
  "2xl": `@media (min-width: ${screens["2xl"]})`,
} as const;
