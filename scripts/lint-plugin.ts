/// <reference lib="deno.unstable" />

import { callAntiSlopRules } from "./anti-slop/call-rules.ts";
import { flowAntiSlopRules } from "./anti-slop/flow-rules.ts";
import { syntaxAntiSlopRules } from "./anti-slop/syntax-rules.ts";
import { typeAntiSlopRules } from "./anti-slop/type-rules.ts";
import { disposableStackRules } from "./lint-rules/disposable-stack-rules.ts";
import { resultRules } from "./lint-rules/result-rules.ts";

function isRetiredSdk(value: unknown): boolean {
  return typeof value === "string" &&
    /^(?:npm:)?@earendil-works\/pi-coding-agent(?:@|\/|$)/u.test(value);
}

const plugin = {
  name: "openorb",
  rules: {
    ...callAntiSlopRules,
    ...disposableStackRules,
    ...flowAntiSlopRules,
    ...syntaxAntiSlopRules,
    ...typeAntiSlopRules,
    ...resultRules,
    "no-retired-pi-sdk": {
      create(context) {
        if (!context.filename.replaceAll("\\", "/").includes("packages/")) return {};
        const message = "Use Pi Durable; the pi-coding-agent integration has been removed.";
        return {
          ImportDeclaration(node) {
            if (isRetiredSdk(node.source.value)) context.report({ node, message });
          },
          ImportExpression(node) {
            const specifier = node.source.type === "Literal"
              ? node.source.value
              : node.source.type === "TemplateLiteral" && node.source.expressions.length === 0
              ? node.source.quasis[0]?.cooked
              : undefined;
            if (isRetiredSdk(specifier)) context.report({ node, message });
          },
          ExportNamedDeclaration(node) {
            if (node.source && isRetiredSdk(node.source.value)) context.report({ node, message });
          },
          ExportAllDeclaration(node) {
            if (isRetiredSdk(node.source.value)) context.report({ node, message });
          },
        };
      },
    },
  },
} satisfies Deno.lint.Plugin;

export default plugin;
