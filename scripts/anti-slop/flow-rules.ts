/// <reference lib="deno.unstable" />

// Adapted from dmmulroy/anti-slop, revision 446268e5d15baa968eaec669ff65358d36ae6259.

type Node = Deno.lint.Node;
type Expression = Deno.lint.Expression;
type TypeNode = Extract<Node, { type: `TS${string}` }>;
type Declarator = Extract<Node, { type: "VariableDeclarator" }>;
type FunctionNode = Extract<
  Node,
  { type: "ArrowFunctionExpression" | "FunctionDeclaration" | "FunctionExpression" }
>;
type Assertion = Extract<Node, { type: "TSAsExpression" | "TSTypeAssertion" }>;
type Target = "unknown" | "object" | "anonymous object" | "open dictionary" | "generic container";
type BroadKind = "top" | "object" | "record";

const FUNCTIONS = new Set(["ArrowFunctionExpression", "FunctionDeclaration", "FunctionExpression"]);
const BUILT_INS = new Set(["Record", "Readonly", "Partial", "Required", "PropertyKey"]);

function unwrapExpression(expression: Expression): Expression {
  let current = expression;
  while (
    current.type === "TSAsExpression" || current.type === "TSTypeAssertion" ||
    current.type === "TSSatisfiesExpression" || current.type === "TSNonNullExpression"
  ) current = current.expression;
  return current;
}

function unwrapType(type: TypeNode): TypeNode {
  let current = type;
  while (current.type === "TSTypeOperator" && current.operator === "readonly") {
    current = current.typeAnnotation;
  }
  return current;
}

function parentOf(node: Node): Node | null {
  return (node as Node & { readonly parent: Node | null }).parent;
}

function referenceName(type: TypeNode): string | null {
  const value = unwrapType(type);
  return value.type === "TSTypeReference" && value.typeName.type === "Identifier"
    ? value.typeName.name
    : null;
}

function declaredStatement(statement: Deno.lint.Statement): Node | null {
  return statement.type === "ExportNamedDeclaration" ||
      statement.type === "ExportDefaultDeclaration"
    ? statement.declaration ?? null
    : statement;
}

function knownSyntax(expression: Expression): boolean {
  const value = unwrapExpression(expression);
  return value.type === "ObjectExpression" || value.type === "ArrayExpression" ||
    value.type === "ArrowFunctionExpression" || value.type === "ClassExpression" ||
    value.type === "FunctionExpression" || value.type === "NewExpression" ||
    value.type === "Literal" || value.type === "TemplateLiteral" ||
    value.type === "UnaryExpression";
}

function boundary(node: Node): FunctionNode | null {
  let current = parentOf(node);
  while (current !== null && current.type !== "Program") {
    if (FUNCTIONS.has(current.type)) return current as FunctionNode;
    current = parentOf(current);
  }
  return null;
}

function boundaryKey(node: Node): string {
  const owner = boundary(node);
  return owner === null ? "program" : `${owner.range[0]}:${owner.range[1]}`;
}

function blockPath(node: Node): readonly string[] {
  const result: string[] = [];
  let current = parentOf(node);
  const owner = boundary(node);
  while (current !== null && current !== owner && current.type !== "Program") {
    if (current.type === "BlockStatement" || current.type === "CatchClause") {
      result.push(`${current.range[0]}:${current.range[1]}`);
    }
    current = parentOf(current);
  }
  return result.reverse();
}

function pathContains(binding: readonly string[], use: readonly string[]): boolean {
  return binding.every((part, index) => use[index] === part);
}

function isEmptyObject(expression: Expression): boolean {
  const value = unwrapExpression(expression);
  return value.type === "ObjectExpression" && value.properties.length === 0;
}

function isBroadMappedKey(type: TypeNode, shadowedBuiltIns: ReadonlySet<string>): boolean {
  const value = unwrapType(type);
  if (
    value.type === "TSStringKeyword" || value.type === "TSNumberKeyword" ||
    value.type === "TSSymbolKeyword"
  ) return true;
  if (value.type === "TSUnionType") {
    return value.types.every((member) => isBroadMappedKey(member, shadowedBuiltIns));
  }
  return referenceName(value) === "PropertyKey" && !shadowedBuiltIns.has("PropertyKey");
}

function isUnknownOrAny(type: TypeNode): boolean {
  const value = unwrapType(type);
  return value.type === "TSUnknownKeyword" || value.type === "TSAnyKeyword";
}

function launderingBroadKind(type: TypeNode): BroadKind | null {
  const value = unwrapType(type);
  if (value.type === "TSUnknownKeyword" || value.type === "TSAnyKeyword") return "top";
  if (value.type === "TSObjectKeyword") return "object";
  if (value.type === "TSTypeReference" && value.typeName.type === "Identifier") {
    if (value.typeName.name === "Readonly") {
      const inner = value.typeArguments?.params[0];
      return inner === undefined ? null : launderingBroadKind(inner);
    }
    if (value.typeName.name !== "Record") return null;
    const [key, item] = value.typeArguments?.params ?? [];
    return key !== undefined && item !== undefined && isBroadMappedKey(key, new Set()) &&
        isUnknownOrAny(item)
      ? "record"
      : null;
  }
  if (value.type !== "TSTypeLiteral" || value.members.length !== 1) return null;
  const [member] = value.members;
  const [parameter] = member?.type === "TSIndexSignature" ? member.parameters : [];
  return member?.type === "TSIndexSignature" && parameter?.type === "Identifier" &&
      parameter.typeAnnotation !== undefined &&
      member.typeAnnotation !== undefined &&
      isBroadMappedKey(parameter.typeAnnotation.typeAnnotation, new Set()) &&
      isUnknownOrAny(member.typeAnnotation.typeAnnotation)
    ? "record"
    : null;
}

function isDefinitelyObjectType(type: TypeNode): boolean {
  const value = unwrapType(type);
  switch (value.type) {
    case "TSArrayType":
    case "TSFunctionType":
    case "TSMappedType":
    case "TSObjectKeyword":
    case "TSTupleType":
      return true;
    case "TSTypeLiteral":
      return value.members.length > 0;
    case "TSIntersectionType":
      return value.types.every(isDefinitelyObjectType);
    default:
      return false;
  }
}

function isDefinitelyNarrowerRecord(type: TypeNode): boolean {
  const value = unwrapType(type);
  if (value.type === "TSTypeLiteral") {
    return value.members.some((member) => member.type !== "TSIndexSignature");
  }
  if (value.type !== "TSTypeReference" || value.typeName.type !== "Identifier") return false;
  if (value.typeName.name === "Readonly") {
    const inner = value.typeArguments?.params[0];
    return inner !== undefined && isDefinitelyNarrowerRecord(inner);
  }
  if (value.typeName.name !== "Record") return false;
  const item = value.typeArguments?.params[1];
  return item !== undefined && item.type !== "TSUnknownKeyword" && item.type !== "TSAnyKeyword";
}

function assertionFromExpression(expression: Expression): Assertion | null {
  return expression.type === "TSAsExpression" || expression.type === "TSTypeAssertion"
    ? expression
    : null;
}

function makeRule(widenThenAssert: boolean): Deno.lint.Rule {
  return {
    create(context) {
      const aliases = new Map<string, Extract<Node, { type: "TSTypeAliasDeclaration" }>>();
      const shadowedBuiltIns = new Set<string>();
      const declarations: Declarator[] = [];
      const reassigned = new Set<string>();

      function classifyAlias(type: TypeNode, resolving: ReadonlySet<string>): Target | null {
        const value = unwrapType(type);
        if (value.type === "TSUnknownKeyword" || value.type === "TSAnyKeyword") return "unknown";
        if (value.type === "TSObjectKeyword") return "object";
        if (value.type === "TSTypeLiteral") {
          return value.members.some((member) => member.type === "TSIndexSignature")
            ? "open dictionary"
            : null;
        }
        if (value.type === "TSMappedType") {
          return isBroadMappedKey(value.constraint, shadowedBuiltIns) ? "open dictionary" : null;
        }
        const name = referenceName(value);
        if (name === null) return null;
        if (
          (name === "Readonly" || name === "Partial" || name === "Required") &&
          !shadowedBuiltIns.has(name)
        ) {
          const inner = value.type === "TSTypeReference"
            ? value.typeArguments?.params[0]
            : undefined;
          return inner === undefined ? null : classifyAlias(inner, resolving);
        }
        if (name === "Record" && !shadowedBuiltIns.has(name)) return "open dictionary";
        const alias = aliases.get(name);
        if (alias === undefined || resolving.has(name)) return null;
        const next = new Set(resolving);
        next.add(name);
        return classifyAlias(alias.typeAnnotation, next);
      }

      function classify(type: TypeNode): Target | null {
        const value = unwrapType(type);
        if (value.type === "TSUnknownKeyword" || value.type === "TSAnyKeyword") return "unknown";
        if (value.type === "TSObjectKeyword") return "object";
        if (value.type === "TSTypeLiteral") {
          return value.members.some((member) => member.type === "TSIndexSignature")
            ? "open dictionary"
            : value.members.length > 0
            ? "anonymous object"
            : null;
        }
        if (value.type === "TSMappedType") return "open dictionary";
        const name = referenceName(value);
        if (name === null) return null;
        if (
          (name === "Readonly" || name === "Partial" || name === "Required") &&
          !shadowedBuiltIns.has(name)
        ) {
          const inner = value.type === "TSTypeReference"
            ? value.typeArguments?.params[0]
            : undefined;
          return inner === undefined ? null : classify(inner);
        }
        if (name === "Record" && !shadowedBuiltIns.has(name)) return "open dictionary";
        const alias = aliases.get(name);
        if (alias === undefined) return null;
        const result = classifyAlias(alias.typeAnnotation, new Set([name]));
        return (alias.typeParameters?.params.length ?? 0) > 0 && result === "open dictionary"
          ? "generic container"
          : result;
      }

      function bindingFor(identifier: Extract<Node, { type: "Identifier" }>): Declarator | null {
        const usePath = blockPath(identifier);
        const candidates = declarations.filter((candidate) =>
          candidate.id.type === "Identifier" && candidate.id.name === identifier.name &&
          candidate.range[0] < identifier.range[0] &&
          boundaryKey(candidate) === boundaryKey(identifier) &&
          pathContains(blockPath(candidate), usePath)
        );
        return candidates.length === 0 ? null : candidates[candidates.length - 1] ?? null;
      }

      function hasKnown(
        expression: Expression,
        use: Node,
        visited = new Set<Declarator>(),
      ): boolean {
        if (knownSyntax(expression)) return true;
        const value = unwrapExpression(expression);
        if (value.type !== "Identifier") return false;
        const declaration = bindingFor(value);
        if (
          declaration === null || visited.has(declaration) || declaration.init === null ||
          declaration.parent.type !== "VariableDeclaration" ||
          declaration.parent.kind !== "const" ||
          boundaryKey(declaration) !== boundaryKey(use) ||
          reassigned.has(`${boundaryKey(declaration)}:${value.name}`)
        ) return false;
        visited.add(declaration);
        return hasKnown(declaration.init, declaration, visited);
      }

      function reportFlow(
        expression: Expression,
        type: TypeNode | undefined,
        subject: string,
      ): void {
        if (type === undefined) return;
        const target = classify(type);
        if (
          target === null || ((target === "open dictionary" || target === "generic container") &&
            isEmptyObject(expression)) ||
          !hasKnown(expression, expression)
        ) return;
        context.report({
          node: expression,
          message:
            `The explicit ${target} type on ${subject} discards known type evidence. Keep inference, validate with \`satisfies\`, or use a named owner contract.`,
        });
      }

      function checkAssertion(node: Assertion): void {
        const expression = unwrapExpression(node.expression);
        if (expression.type !== "Identifier") return;
        const declaration = bindingFor(expression);
        if (
          declaration === null || declaration.init === null ||
          declaration.parent.type !== "VariableDeclaration" ||
          declaration.parent.kind !== "const" ||
          declaration.id.type !== "Identifier" ||
          reassigned.has(`${boundaryKey(declaration)}:${expression.name}`)
        ) return;
        const initializerAssertion = assertionFromExpression(declaration.init);
        const declaredBroadKind = declaration.id.typeAnnotation === undefined
          ? null
          : launderingBroadKind(declaration.id.typeAnnotation.typeAnnotation);
        const initializerBroadKind = initializerAssertion === null
          ? null
          : launderingBroadKind(initializerAssertion.typeAnnotation);
        const kind = declaredBroadKind ?? initializerBroadKind;
        if (kind === null || launderingBroadKind(node.typeAnnotation) !== null) return;
        const evidence = initializerAssertion !== null && initializerBroadKind !== null
          ? initializerAssertion.expression
          : declaration.init;
        if (!hasKnown(evidence, declaration)) return;
        const narrower = kind === "top" ||
          (kind === "object" && isDefinitelyObjectType(node.typeAnnotation)) ||
          (kind === "record" && isDefinitelyNarrowerRecord(node.typeAnnotation));
        if (!narrower) return;
        context.report({
          node,
          message:
            `Binding "${expression.name}" discards type evidence and later recreates it with an assertion. Keep the precise type from initialization through use; parse boundary input once.`,
        });
      }

      return {
        Program(node) {
          aliases.clear();
          shadowedBuiltIns.clear();
          for (const statement of node.body) {
            const declaration = declaredStatement(statement);
            if (declaration?.type === "ImportDeclaration") {
              for (const specifier of declaration.specifiers) {
                if (BUILT_INS.has(specifier.local.name)) {
                  shadowedBuiltIns.add(specifier.local.name);
                }
              }
            } else if (declaration?.type === "TSTypeAliasDeclaration") {
              if (!aliases.has(declaration.id.name)) aliases.set(declaration.id.name, declaration);
              if (BUILT_INS.has(declaration.id.name)) {
                shadowedBuiltIns.add(declaration.id.name);
              }
            } else if (
              declaration?.type === "TSInterfaceDeclaration" ||
              declaration?.type === "TSEnumDeclaration" ||
              declaration?.type === "ClassDeclaration" ||
              declaration?.type === "FunctionDeclaration"
            ) {
              if (declaration.id && BUILT_INS.has(declaration.id.name)) {
                shadowedBuiltIns.add(declaration.id.name);
              }
            }
          }
        },
        VariableDeclarator(node) {
          declarations.push(node);
          if (!widenThenAssert && node.init !== null && node.id.type === "Identifier") {
            reportFlow(
              node.init,
              node.id.typeAnnotation?.typeAnnotation,
              `binding \`${node.id.name}\``,
            );
          }
        },
        AssignmentExpression(node) {
          if (node.left.type === "Identifier") {
            reassigned.add(`${boundaryKey(node)}:${node.left.name}`);
          }
          if (!widenThenAssert && node.operator === "=" && node.left.type === "Identifier") {
            const declaration = bindingFor(node.left);
            if (declaration?.id.type === "Identifier") {
              reportFlow(
                node.right,
                declaration.id.typeAnnotation?.typeAnnotation,
                `binding \`${node.left.name}\``,
              );
            }
          }
        },
        PropertyDefinition(node) {
          if (!widenThenAssert && node.value !== null) {
            reportFlow(node.value, node.typeAnnotation?.typeAnnotation, "property");
          }
        },
        ReturnStatement(node) {
          if (!widenThenAssert && node.argument !== null) {
            reportFlow(node.argument, boundary(node)?.returnType?.typeAnnotation, "return value");
          }
        },
        ArrowFunctionExpression(node) {
          if (!widenThenAssert && node.body.type !== "BlockStatement") {
            reportFlow(node.body, node.returnType?.typeAnnotation, "return value");
          }
        },
        TSAsExpression(node) {
          if (widenThenAssert) checkAssertion(node);
          else if (
            node.parent.type !== "TSAsExpression" && node.parent.type !== "TSTypeAssertion"
          ) {
            reportFlow(node.expression, node.typeAnnotation, "assertion");
          }
        },
        TSTypeAssertion(node) {
          if (widenThenAssert) checkAssertion(node);
          else if (
            node.parent.type !== "TSAsExpression" && node.parent.type !== "TSTypeAssertion"
          ) {
            reportFlow(node.expression, node.typeAnnotation, "assertion");
          }
        },
      };
    },
  };
}

export const flowAntiSlopRules: Record<string, Deno.lint.Rule> = {
  "no-known-value-widening": makeRule(false),
  "no-widen-then-assert": makeRule(true),
};
