import type { TSESLint, TSESTree } from "@typescript-eslint/utils";

// Behavior adapted from dmmulroy/anti-slop at
// 446268e5d15baa968eaec669ff65358d36ae6259 (MIT licensed).

function addPatternBindings(
  pattern: TSESTree.Parameter | TSESTree.VariableDeclarator["id"],
  bindings: Set<string>,
): void {
  switch (pattern.type) {
    case "Identifier":
      bindings.add(pattern.name);
      break;
    case "AssignmentPattern":
      addPatternBindings(pattern.left, bindings);
      break;
    case "RestElement":
      if (pattern.argument.type !== "MemberExpression") {
        addPatternBindings(pattern.argument, bindings);
      }
      break;
    case "ArrayPattern":
      for (const element of pattern.elements) {
        if (element !== null && element.type !== "MemberExpression") {
          addPatternBindings(element, bindings);
        }
      }
      break;
    case "ObjectPattern":
      for (const property of pattern.properties) {
        if (property.type === "RestElement") {
          if (property.argument.type !== "MemberExpression") {
            addPatternBindings(property.argument, bindings);
          }
        } else {
          const value = property.value;
          if (
            value.type === "Identifier" ||
            value.type === "AssignmentPattern" ||
            value.type === "ArrayPattern" ||
            value.type === "ObjectPattern"
          ) {
            addPatternBindings(value, bindings);
          }
        }
      }
      break;
    case "TSParameterProperty":
      addPatternBindings(pattern.parameter, bindings);
      break;
  }
}

function addStatementBindings(statement: TSESTree.Statement, bindings: Set<string>): void {
  const declaration =
    statement.type === "ExportNamedDeclaration" || statement.type === "ExportDefaultDeclaration"
      ? statement.declaration
      : statement;
  if (declaration === null) return;

  if (declaration.type === "VariableDeclaration") {
    for (const declarator of declaration.declarations) {
      addPatternBindings(declarator.id, bindings);
    }
  } else if (
    declaration.type === "FunctionDeclaration" ||
    declaration.type === "ClassDeclaration"
  ) {
    if (declaration.id !== null) bindings.add(declaration.id.name);
  }
}

function scopeBindings(scope: TSESTree.Node): Set<string> | null {
  const bindings = new Set<string>();
  if (scope.type === "Program") {
    for (const statement of scope.body) {
      if (statement.type === "ImportDeclaration") {
        for (const specifier of statement.specifiers) {
          if (
            statement.importKind === "type" ||
            (specifier.type === "ImportSpecifier" && specifier.importKind === "type")
          ) {
            continue;
          }
          bindings.add(specifier.local.name);
        }
      } else {
        addStatementBindings(statement, bindings);
      }
    }
    return bindings;
  }
  if (scope.type === "BlockStatement") {
    for (const statement of scope.body) addStatementBindings(statement, bindings);
    return bindings;
  }
  if (
    scope.type === "FunctionDeclaration" ||
    scope.type === "FunctionExpression" ||
    scope.type === "ArrowFunctionExpression"
  ) {
    for (const parameter of scope.params) addPatternBindings(parameter, bindings);
    if (scope.type === "FunctionExpression" && scope.id !== null) {
      bindings.add(scope.id.name);
    }
    return bindings;
  }
  if (scope.type === "CatchClause" && scope.param !== null) {
    addPatternBindings(scope.param, bindings);
    return bindings;
  }
  return null;
}

function hasBinding(
  context: TSESLint.RuleContext<string, []>,
  node: TSESTree.Node,
  name: string,
): boolean {
  const ancestors = context.sourceCode.getAncestors(node);
  for (let index = ancestors.length - 1; index >= 0; index--) {
    const scope = ancestors[index];
    if (scope === undefined) continue;
    if (scopeBindings(scope)?.has(name)) return true;
  }
  return false;
}

function calledMethod(
  node: TSESTree.CallExpression,
): { object: TSESTree.Identifier; name: string } | null {
  if (node.callee.type !== "MemberExpression" || node.callee.object.type !== "Identifier") {
    return null;
  }
  const property = node.callee.property;
  const name = node.callee.computed
    ? property.type === "Literal" && typeof property.value === "string"
      ? property.value
      : null
    : property.type === "Identifier"
      ? property.name
      : null;
  return name === null ? null : { object: node.callee.object, name };
}

function reflectRule(method: "apply" | "get", message: string): TSESLint.RuleModule<string, []> {
  return {
    meta: { type: "problem", schema: [], messages: { reflect: message } },
    defaultOptions: [],
    create(context) {
      return {
        CallExpression(node) {
          const call = calledMethod(node);
          if (
            call?.object.name === "Reflect" &&
            call.name === method &&
            !hasBinding(context, call.object, "Reflect")
          ) {
            context.report({ node, messageId: "reflect" });
          }
        },
      };
    },
  };
}

export const callAntiSlopRules: Record<string, TSESLint.RuleModule<string, []>> = {
  "no-reflect-apply": reflectRule(
    "apply",
    "Replace `Reflect.apply` with a typed function call. Model dynamic dispatch behind a named interface.",
  ),
  "no-reflect-get": reflectRule(
    "get",
    "Replace `Reflect.get` with typed property access. Parse dynamic input into a named domain type before reading it.",
  ),
};
