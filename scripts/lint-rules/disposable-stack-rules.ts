/// <reference lib="deno.unstable" />

// OpenOrb-specific cleanup policy.
const message =
  "Use DisposableStack or AsyncDisposableStack to declare cleanup instead of try/finally.";

function isTestFile(filename: string): boolean {
  const path = filename.replaceAll("\\", "/");
  return path.includes("/test/") || /\.(?:test|bench)\.[cm]?[jt]sx?$/.test(path);
}

const preferDisposableStack = {
  create(context) {
    if (isTestFile(context.filename)) return {};
    return {
      TryStatement(node) {
        if (node.finalizer !== null) context.report({ node, message });
      },
    };
  },
} satisfies Deno.lint.Rule;

export const disposableStackRules = {
  "prefer-disposable-stack": preferDisposableStack,
} satisfies Record<string, Deno.lint.Rule>;
