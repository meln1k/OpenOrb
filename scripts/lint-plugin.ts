/// <reference lib="deno.unstable" />

import { callAntiSlopRules } from "./anti-slop/call-rules.ts";
import { flowAntiSlopRules } from "./anti-slop/flow-rules.ts";
import { syntaxAntiSlopRules } from "./anti-slop/syntax-rules.ts";
import { typeAntiSlopRules } from "./anti-slop/type-rules.ts";
import { disposableStackRules } from "./lint-rules/disposable-stack-rules.ts";
import { resultRules } from "./lint-rules/result-rules.ts";

const PI_CODING_AGENT_PACKAGE = "@earendil-works/pi-coding-agent";
const PI_SESSION_FACTORY_PATH = "packages/runner/src/harness/pi/session.ts";
const PI_SESSION_CONSTRUCTORS = new Set([
  "AgentSession",
  "AgentSessionRuntime",
  "createAgentSession",
  "createAgentSessionFromServices",
  "createAgentSessionRuntime",
  "createAgentSessionServices",
]);

function isRunnerFile(filename: string): boolean {
  return filename.replaceAll("\\", "/").includes("packages/runner/");
}

function isPiSessionFactory(filename: string): boolean {
  return filename.replaceAll("\\", "/").endsWith(PI_SESSION_FACTORY_PATH);
}

function isPiCodingAgentSpecifier(value: unknown): boolean {
  return typeof value === "string" &&
    (value === PI_CODING_AGENT_PACKAGE ||
      value === `npm:${PI_CODING_AGENT_PACKAGE}` ||
      value.startsWith(`npm:${PI_CODING_AGENT_PACKAGE}@`));
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
    "no-default-pi-resource-loader": {
      create(context) {
        if (!isRunnerFile(context.filename)) return {};

        return {
          ImportDeclaration(node) {
            if (!isPiCodingAgentSpecifier(node.source.value)) return;
            for (const specifier of node.specifiers) {
              if (specifier.type === "ImportNamespaceSpecifier") {
                context.report({
                  node: specifier,
                  message: "Runner code must not namespace-import the Pi SDK.",
                });
                continue;
              }
              if (
                specifier.type === "ImportSpecifier" &&
                specifier.imported.type === "Identifier" &&
                specifier.imported.name === "DefaultResourceLoader"
              ) {
                context.report({
                  node: specifier,
                  message: "Runner code must use OpenOrb's explicit ResourceLoader.",
                });
              }
            }
          },
          ImportExpression(node) {
            const specifier = node.source.type === "Literal"
              ? node.source.value
              : node.source.type === "TemplateLiteral" && node.source.expressions.length === 0
              ? node.source.quasis[0]?.cooked
              : undefined;
            if (isPiCodingAgentSpecifier(specifier)) {
              context.report({
                node,
                message: "Runner code must statically import only audited Pi SDK symbols.",
              });
            }
          },
          ExportNamedDeclaration(node) {
            if (node.source && isPiCodingAgentSpecifier(node.source.value)) {
              context.report({
                node,
                message: "Runner code must not re-export Pi SDK symbols.",
              });
            }
          },
          ExportAllDeclaration(node) {
            if (isPiCodingAgentSpecifier(node.source.value)) {
              context.report({
                node,
                message: "Runner code must not re-export Pi SDK symbols.",
              });
            }
          },
        };
      },
    },
    "no-direct-pi-session-construction": {
      create(context) {
        if (!isRunnerFile(context.filename) || isPiSessionFactory(context.filename)) return {};

        return {
          ImportDeclaration(node) {
            if (!isPiCodingAgentSpecifier(node.source.value)) return;
            for (const specifier of node.specifiers) {
              if (specifier.type === "ImportNamespaceSpecifier") {
                context.report({
                  node: specifier,
                  message: "Runner code must create Pi sessions through createOpenOrbPiSession.",
                });
                continue;
              }
              if (
                specifier.type === "ImportSpecifier" &&
                specifier.imported.type === "Identifier" &&
                PI_SESSION_CONSTRUCTORS.has(specifier.imported.name) &&
                node.importKind !== "type" &&
                specifier.importKind !== "type"
              ) {
                context.report({
                  node: specifier,
                  message: "Runner code must create Pi sessions through createOpenOrbPiSession.",
                });
              }
            }
          },
        };
      },
    },
    "no-file-backed-pi-settings": {
      create(context) {
        if (!isRunnerFile(context.filename)) return {};
        const settingsManagerNames = new Set<string>();

        return {
          ImportDeclaration(node) {
            if (!isPiCodingAgentSpecifier(node.source.value)) return;
            for (const specifier of node.specifiers) {
              if (
                specifier.type === "ImportSpecifier" &&
                specifier.imported.type === "Identifier" &&
                specifier.imported.name === "SettingsManager"
              ) {
                settingsManagerNames.add(specifier.local.name);
              }
            }
          },
          CallExpression(node) {
            if (
              node.callee.type !== "MemberExpression" ||
              node.callee.object.type !== "Identifier" ||
              !settingsManagerNames.has(node.callee.object.name)
            ) {
              return;
            }
            const propertyName = node.callee.computed
              ? node.callee.property.type === "Literal" ? node.callee.property.value : undefined
              : node.callee.property.type === "Identifier"
              ? node.callee.property.name
              : undefined;
            if (propertyName !== "create") return;

            context.report({
              node: node.callee,
              message: "Runner Pi settings must use SettingsManager.inMemory(...).",
            });
          },
        };
      },
    },
  },
} satisfies Deno.lint.Plugin;

export default plugin;
