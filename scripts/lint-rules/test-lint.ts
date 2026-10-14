import { TSESLint } from "@typescript-eslint/utils";
import * as parser from "@typescript-eslint/parser";

export interface Diagnostic {
  id: string;
  message: string;
  range: [number, number];
}

/** Exercise the public ESLint-compatible API, including native disable directives. */
export function lintPlugin(
  plugin: TSESLint.FlatConfig.Plugin,
  filename: string,
  source: string,
): Diagnostic[] {
  const linter = new TSESLint.Linter();
  const lines = source.split("\n");
  const offset = (line: number, column: number) =>
    lines.slice(0, line - 1).reduce((sum, text) => sum + text.length + 1, 0) + column - 1;
  const messages = linter.verify(
    source,
    [
      {
        files: ["**/*.{ts,tsx,js,jsx}"],
        languageOptions: { parser, ecmaVersion: "latest", sourceType: "module" },
        plugins: { openorb: plugin },
        rules: Object.fromEntries(
          Object.keys(plugin.rules ?? {}).map((name) => [`openorb/${name}`, "error"]),
        ),
      },
    ],
    { filename },
  );
  return messages.map((diagnostic) => {
    if (diagnostic.fatal || !diagnostic.ruleId) {
      throw new Error(`Lint fixture ${filename}: ${diagnostic.message}`);
    }
    return {
      id: diagnostic.ruleId,
      message: diagnostic.message,
      range: [
        offset(diagnostic.line, diagnostic.column),
        offset(diagnostic.endLine ?? diagnostic.line, diagnostic.endColumn ?? diagnostic.column),
      ],
    };
  });
}
