# Recipe: apply a resolved theme

Convert one resolved Shiki or VS Code theme to CSS properties on the tree host:

```ts
import { themeToTreeStyles } from '@pierre/trees';

const host = tree.getFileTreeContainer();
for (const [property, value] of Object.entries(themeToTreeStyles(resolvedTheme))) {
  host?.style.setProperty(property, value);
}
```

Reapply the styles when the resolved theme changes. Set tree override CSS
properties on the same host when the product needs a local color choice.
