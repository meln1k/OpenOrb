/// <reference lib="deno.unstable" />

const plugin = {
  name: "openorb",
  rules: {
    "no-record-string-unknown": {
      create(context) {
        return {
          TSTypeReference(node) {
            const [keyType, valueType] = node.typeArguments?.params ?? [];
            if (
              node.typeName.type !== "Identifier" ||
              node.typeName.name !== "Record" ||
              node.typeArguments?.params.length !== 2 ||
              keyType?.type !== "TSStringKeyword" ||
              valueType?.type !== "TSUnknownKeyword"
            ) {
              return;
            }

            context.report({
              node,
              message: "Do not use `Record<string, unknown>`; use a named or concrete type.",
            });
          },
        };
      },
    },
  },
} satisfies Deno.lint.Plugin;

export default plugin;
