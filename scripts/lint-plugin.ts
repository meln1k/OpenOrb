import type { TSESLint } from "@typescript-eslint/utils";

import { callAntiSlopRules } from "./anti-slop/call-rules.ts";
import { flowAntiSlopRules } from "./anti-slop/flow-rules.ts";
import { syntaxAntiSlopRules } from "./anti-slop/syntax-rules.ts";
import { typeAntiSlopRules } from "./anti-slop/type-rules.ts";
import { disposableStackRules } from "./lint-rules/disposable-stack-rules.ts";
import { resultRules } from "./lint-rules/result-rules.ts";

function isRetiredSdk(value: unknown): boolean {
  return (
    typeof value === "string" && /^(?:npm:)?@earendil-works\/pi-coding-agent(?:@|\/|$)/u.test(value)
  );
}

const plugin = {
  meta: { name: "openorb" },
  rules: {
    ...callAntiSlopRules,
    ...disposableStackRules,
    ...flowAntiSlopRules,
    ...syntaxAntiSlopRules,
    ...typeAntiSlopRules,
    ...resultRules,
    "no-retired-pi-sdk": {
      meta: {
        type: "problem",
        schema: [],
        messages: {
          retired: "Use Pi Durable; the pi-coding-agent integration has been removed.",
        },
      },
      defaultOptions: [],
      create(context) {
        if (!context.filename.replaceAll("\\", "/").includes("packages/")) return {};
        return {
          ImportDeclaration(node) {
            if (isRetiredSdk(node.source.value)) context.report({ node, messageId: "retired" });
          },
          ImportExpression(node) {
            const specifier =
              node.source.type === "Literal"
                ? node.source.value
                : node.source.type === "TemplateLiteral" && node.source.expressions.length === 0
                  ? node.source.quasis[0]?.value.cooked
                  : undefined;
            if (isRetiredSdk(specifier)) context.report({ node, messageId: "retired" });
          },
          ExportNamedDeclaration(node) {
            if (node.source && isRetiredSdk(node.source.value)) {
              context.report({ node, messageId: "retired" });
            }
          },
          ExportAllDeclaration(node) {
            if (isRetiredSdk(node.source.value)) context.report({ node, messageId: "retired" });
          },
        };
      },
    } satisfies TSESLint.RuleModule<string, []>,
  },
} satisfies { meta: { name: string }; rules: Record<string, TSESLint.RuleModule<string, []>> };

export default plugin;
