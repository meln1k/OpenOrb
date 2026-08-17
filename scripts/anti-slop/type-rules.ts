/// <reference lib="deno.unstable" />

// Syntax behavior adapted from dmmulroy/anti-slop (revision
// 446268e5d15baa968eaec669ff65358d36ae6259), under its MIT license.

type Node = Deno.lint.Node;
type TypeNode = Deno.lint.TSTypeAnnotation["typeAnnotation"];
type Alias = Deno.lint.TSTypeAliasDeclaration;
interface UnknownObject {
  readonly [key: string]: unknown;
}
type FunctionNode = Node & {
  readonly params: readonly Node[];
  readonly returnType?: Deno.lint.TSTypeAnnotation | null;
};
type Environment = {
  aliases: Map<string, Alias>;
  interfaces: Map<string, Deno.lint.TSInterfaceDeclaration[]>;
  shadowedBuiltIns: Set<string>;
};
type Substitutions = ReadonlyMap<string, TypeNode>;
type Unsafe = "any" | "empty-object" | "object" | "union" | "unknown";

const BUILT_INS = new Set([
  "Record",
  "Readonly",
  "Partial",
  "Required",
  "Pick",
  "Omit",
  "PropertyKey",
  "NonNullable",
]);
const WRAPPERS = new Set(["Readonly", "Partial", "Required", "NonNullable"]);

function isNode(value: unknown): value is Node {
  return typeof value === "object" && value !== null && "type" in value &&
    typeof value.type === "string";
}

/** Deno exposes no visitor keys. Only AST-shaped property values are followed; `parent` is not. */
function children(node: Node): Node[] {
  const result: Node[] = [];
  const record = node as unknown as UnknownObject;
  for (const key in record) {
    if (key === "parent" || key === "loc" || key === "range") continue;
    const value = record[key];
    if (isNode(value)) result.push(value);
    else if (Array.isArray(value)) {
      for (const item of value) if (isNode(item)) result.push(item);
    }
  }
  return result;
}

function walk(
  node: Node,
  ancestors: readonly Node[],
  visit: (n: Node, a: readonly Node[]) => void,
) {
  visit(node, ancestors);
  const next = [...ancestors, node];
  for (const child of children(node)) walk(child, next, visit);
}

function declaration(statement: Node): Node | null {
  if (
    statement.type === "ExportNamedDeclaration" || statement.type === "ExportDefaultDeclaration"
  ) {
    return statement.declaration ?? null;
  }
  return statement;
}

function environment(program: Deno.lint.Program): Environment {
  const aliases = new Map<string, Alias>();
  const interfaces = new Map<string, Deno.lint.TSInterfaceDeclaration[]>();
  const shadowedBuiltIns = new Set<string>();
  for (const statement of program.body) {
    const item = declaration(statement);
    if (item?.type === "ImportDeclaration") {
      for (const specifier of item.specifiers) {
        if (BUILT_INS.has(specifier.local.name)) shadowedBuiltIns.add(specifier.local.name);
      }
    } else if (item?.type === "TSTypeAliasDeclaration") {
      if (aliases.has(item.id.name)) shadowedBuiltIns.add(item.id.name);
      else aliases.set(item.id.name, item);
      if (BUILT_INS.has(item.id.name)) shadowedBuiltIns.add(item.id.name);
    } else if (item?.type === "TSInterfaceDeclaration") {
      const values = interfaces.get(item.id.name) ?? [];
      values.push(item);
      interfaces.set(item.id.name, values);
      if (BUILT_INS.has(item.id.name)) shadowedBuiltIns.add(item.id.name);
    } else if (
      item?.type === "TSEnumDeclaration" || item?.type === "ClassDeclaration" ||
      item?.type === "FunctionDeclaration"
    ) {
      if (item.id && BUILT_INS.has(item.id.name)) shadowedBuiltIns.add(item.id.name);
    }
  }
  return { aliases, interfaces, shadowedBuiltIns };
}

function referenceName(type: TypeNode): string | null {
  return type.type === "TSTypeReference" && type.typeName.type === "Identifier"
    ? type.typeName.name
    : null;
}

function unwrap(type: TypeNode): TypeNode {
  let value = type;
  while (value.type === "TSTypeOperator" && value.operator === "readonly") {
    value = value.typeAnnotation;
  }
  return value;
}

function lexicalNames(ancestors: readonly Node[], node: Node): Set<string> {
  const names = new Set<string>();
  const path = [...ancestors, node];
  for (let index = 0; index < path.length; index++) {
    const current = path[index];
    if (!current) continue;
    if ("typeParameters" in current) {
      const parameters = current.typeParameters;
      if (
        parameters && typeof parameters === "object" && "params" in parameters &&
        Array.isArray(parameters.params)
      ) {
        for (const parameter of parameters.params) {
          if (isNode(parameter) && parameter.type === "TSTypeParameter") {
            names.add(parameter.name.name);
          }
        }
      }
    }
    const descendant = path[index + 1];
    if (current.type === "TSMappedType" && descendant && descendant !== current.constraint) {
      names.add(current.key.name);
    }
    if (current.type === "TSConditionalType" && descendant === current.trueType) {
      walk(current.extendsType, [], (child) => {
        if (child.type === "TSInferType") names.add(child.typeParameter.name.name);
      });
    }
  }
  return names;
}

function resolvesKeyword(
  type: TypeNode,
  keyword: "TSObjectKeyword" | "TSUnknownKeyword",
  env: Environment,
  shadowed: ReadonlySet<string>,
  visited = new Set<string>(),
): boolean {
  const value = unwrap(type);
  if (value.type === keyword) return true;
  if (value.type === "TSUnionType") {
    return value.types.some((member) => resolvesKeyword(member, keyword, env, shadowed, visited));
  }
  if (
    keyword === "TSUnknownKeyword" && value.type === "TSTypeReference" &&
    value.typeName.type === "Identifier" &&
    (value.typeName.name === "Promise" || value.typeName.name === "PromiseLike")
  ) {
    const inner = value.typeArguments?.params[0];
    return inner !== undefined && resolvesKeyword(inner, keyword, env, shadowed, visited);
  }
  const name = referenceName(value);
  if (
    name === null || value.type !== "TSTypeReference" || value.typeArguments?.params.length ||
    shadowed.has(name) || visited.has(name)
  ) return false;
  const alias = env.aliases.get(name);
  if (!alias || alias.typeParameters) return false;
  const next = new Set(visited);
  next.add(name);
  return resolvesKeyword(alias.typeAnnotation, keyword, env, shadowed, next);
}

function parameterAnnotation(node: Node): Deno.lint.TSTypeAnnotation | null {
  const record = node as unknown as UnknownObject;
  if (node.type === "RestElement") return node.typeAnnotation ?? parameterAnnotation(node.argument);
  if (node.type === "AssignmentPattern") return parameterAnnotation(node.left);
  if (record.parameter && isNode(record.parameter)) return parameterAnnotation(record.parameter);
  const annotation = record.typeAnnotation;
  return isNode(annotation) && annotation.type === "TSTypeAnnotation" ? annotation : null;
}

function isFunctionType(node: Node): node is FunctionNode {
  const record = node as unknown as UnknownObject;
  return Array.isArray(record.params) &&
    (node.type === "ArrowFunctionExpression" || node.type === "FunctionDeclaration" ||
      node.type === "FunctionExpression" || node.type === "TSCallSignatureDeclaration" ||
      node.type === "TSConstructSignatureDeclaration" || node.type === "TSDeclareFunction" ||
      node.type === "TSEmptyBodyFunctionExpression" || node.type === "TSFunctionType" ||
      node.type === "TSMethodSignature");
}

function substitutions(alias: Alias, reference: Deno.lint.TSTypeReference, base: Substitutions) {
  const next = new Map(base);
  const parameters = alias.typeParameters?.params ?? [];
  const arguments_ = reference.typeArguments?.params ?? [];
  for (const [index, parameter] of parameters.entries()) {
    const argument = arguments_[index] ?? parameter.default;
    if (!argument) return null;
    next.set(parameter.name.name, resolveSubstitution(argument, next));
  }
  return next;
}

function resolveSubstitution(
  type: TypeNode,
  substitutions: Substitutions,
  resolving = new Set<string>(),
): TypeNode {
  const value = unwrap(type);
  const name = referenceName(value);
  if (name === null || resolving.has(name)) return type;
  const replacement = substitutions.get(name);
  if (replacement === undefined) return type;
  const next = new Set(resolving);
  next.add(name);
  return resolveSubstitution(replacement, substitutions, next);
}

function isUnappliedReferenceTo(type: TypeNode, name: string): boolean {
  const value = unwrap(type);
  return value.type === "TSTypeReference" && value.typeName.type === "Identifier" &&
    value.typeName.name === name && !value.typeArguments?.params.length;
}

function emptyLiteral(type: Deno.lint.TSTypeLiteral): boolean {
  return type.members.length === 0 ||
    type.members.every(isEffectivelyEmptyMember);
}

function isEffectivelyEmptyMember(
  member:
    | Deno.lint.TSCallSignatureDeclaration
    | Deno.lint.TSConstructSignatureDeclaration
    | Deno.lint.TSIndexSignature
    | Deno.lint.TSMethodSignature
    | Deno.lint.TSPropertySignature,
): boolean {
  return member.type === "TSPropertySignature" && member.optional &&
    member.typeAnnotation?.typeAnnotation.type === "TSNeverKeyword";
}

function emptyInterface(declarations: readonly Deno.lint.TSInterfaceDeclaration[]): boolean {
  if (declarations.length !== 1) return false;
  const [declaration] = declarations;
  return declaration !== undefined && declaration.extends.length === 0 &&
    (declaration.body.body.length === 0 || declaration.body.body.every(isEffectivelyEmptyMember));
}

function unsafeValue(
  type: TypeNode,
  env: Environment,
  subs: Substitutions,
  resolving: ReadonlySet<string>,
): Unsafe | null {
  const value = unwrap(type);
  if (value.type === "TSUnknownKeyword") return "unknown";
  if (value.type === "TSAnyKeyword") return "any";
  if (value.type === "TSObjectKeyword") return "object";
  if (value.type === "TSTypeLiteral" && emptyLiteral(value)) return "empty-object";
  if (value.type === "TSUnionType") {
    return value.types.some((item) => unsafeValue(item, env, subs, resolving)) ? "union" : null;
  }
  if (value.type === "TSIntersectionType") {
    const results = value.types.map((item) => unsafeValue(item, env, subs, resolving));
    if (results.includes("any")) return "any";
    return results.length && results.every((item) => item !== null) ? results[0] ?? null : null;
  }
  if (value.type !== "TSTypeReference") return null;
  const name = referenceName(value);
  if (!name) return null;
  if (WRAPPERS.has(name) && !env.shadowedBuiltIns.has(name)) {
    const inner = value.typeArguments?.params[0];
    return inner ? unsafeValue(inner, env, subs, resolving) : null;
  }
  const replacement = subs.get(name);
  if (replacement) {
    return isUnappliedReferenceTo(replacement, name)
      ? null
      : unsafeValue(replacement, env, subs, resolving);
  }
  const interfaces = env.interfaces.get(name);
  if (interfaces) {
    return emptyInterface(interfaces) ? "empty-object" : null;
  }
  const alias = env.aliases.get(name);
  if (!alias || resolving.has(name)) return null;
  const nextSubs = substitutions(alias, value, subs);
  if (!nextSubs) return null;
  return unsafeValue(alias.typeAnnotation, env, nextSubs, new Set([...resolving, name]));
}

function dictionaryValues(
  type: TypeNode,
  env: Environment,
  subs: Substitutions,
  resolving: ReadonlySet<string>,
): { type: TypeNode; subs: Substitutions }[] {
  const value = unwrap(type);
  if (value.type === "TSTypeLiteral") {
    return value.members.flatMap((member) =>
      member.type === "TSIndexSignature" && member.typeAnnotation
        ? [{ type: member.typeAnnotation.typeAnnotation, subs }]
        : []
    );
  }
  if (value.type === "TSMappedType") {
    return value.typeAnnotation ? [{ type: value.typeAnnotation, subs }] : [];
  }
  if (value.type !== "TSTypeReference") return [];
  const name = referenceName(value);
  if (!name) return [];
  const replacement = subs.get(name);
  if (replacement) {
    return isUnappliedReferenceTo(replacement, name)
      ? []
      : dictionaryValues(replacement, env, subs, resolving);
  }
  if (WRAPPERS.has(name) && !env.shadowedBuiltIns.has(name)) {
    const inner = value.typeArguments?.params[0];
    return inner ? dictionaryValues(inner, env, subs, resolving) : [];
  }
  if (name === "Record" && !env.shadowedBuiltIns.has(name)) {
    const item = value.typeArguments?.params[1];
    return item ? [{ type: item, subs }] : [];
  }
  if ((name === "Pick" || name === "Omit") && !env.shadowedBuiltIns.has(name)) {
    const inner = value.typeArguments?.params[0];
    return inner ? dictionaryValues(inner, env, subs, resolving) : [];
  }
  const alias = env.aliases.get(name);
  if (!alias || resolving.has(name)) return [];
  const nextSubs = substitutions(alias, value, subs);
  return nextSubs
    ? dictionaryValues(alias.typeAnnotation, env, nextSubs, new Set([...resolving, name]))
    : [];
}

function classifyDictionary(type: TypeNode, env: Environment): Unsafe | null {
  for (const value of dictionaryValues(type, env, new Map(), new Set())) {
    const unsafe = unsafeValue(value.type, env, value.subs, new Set());
    if (unsafe) return unsafe;
  }
  return null;
}

function isInsideTypeAlias(context: Deno.lint.RuleContext, node: Node): boolean {
  return context.sourceCode.getAncestors(node).some((ancestor) =>
    ancestor.type === "TSTypeAliasDeclaration"
  );
}

function isPlainAliasConsumer(
  context: Deno.lint.RuleContext,
  node: TypeNode,
  env: Environment,
): boolean {
  return node.type === "TSTypeReference" && node.typeName.type === "Identifier" &&
    !node.typeArguments?.params.length && env.aliases.has(node.typeName.name) &&
    !isInsideTypeAlias(context, node);
}

function typeRule(kind: "object" | "returns"): Deno.lint.Rule {
  return {
    create(context) {
      let env: Environment | null = null;
      const check = (node: FunctionNode) => {
        if (!env) return;
        const shadowed = lexicalNames(context.sourceCode.getAncestors(node), node);
        if (kind === "object") {
          for (const parameter of node.params) {
            const annotation = parameterAnnotation(parameter);
            if (
              annotation &&
              resolvesKeyword(annotation.typeAnnotation, "TSObjectKeyword", env, shadowed)
            ) {
              context.report({
                node: annotation.typeAnnotation,
                message: "Do not use broad `object` parameters; use a named owner type.",
              });
            }
          }
        } else if (
          node.returnType &&
          resolvesKeyword(node.returnType.typeAnnotation, "TSUnknownKeyword", env, shadowed)
        ) {
          context.report({
            node: node.returnType.typeAnnotation,
            message: "Do not expose `unknown` to callers; return a parsed owner type.",
          });
        }
      };
      return {
        Program(program) {
          env = environment(program);
        },
        ArrowFunctionExpression(node) {
          if (isFunctionType(node)) check(node);
        },
        FunctionDeclaration(node) {
          if (isFunctionType(node)) check(node);
        },
        FunctionExpression(node) {
          if (isFunctionType(node)) check(node);
        },
        TSCallSignatureDeclaration(node) {
          if (isFunctionType(node)) check(node);
        },
        TSConstructSignatureDeclaration(node) {
          if (isFunctionType(node)) check(node);
        },
        TSDeclareFunction(node) {
          if (isFunctionType(node)) check(node);
        },
        TSEmptyBodyFunctionExpression(node) {
          if (isFunctionType(node)) check(node);
        },
        TSFunctionType(node) {
          if (isFunctionType(node)) check(node);
        },
        TSMethodSignature(node) {
          if (isFunctionType(node)) check(node);
        },
      };
    },
  };
}

const noUnknownAliases: Deno.lint.Rule = {
  create(context) {
    return {
      Program(program) {
        const env = environment(program);
        for (const alias of env.aliases.values()) {
          if (alias.typeParameters) continue;
          if (
            resolvesKeyword(
              alias.typeAnnotation,
              "TSUnknownKeyword",
              env,
              new Set(),
              new Set([alias.id.name]),
            )
          ) {
            context.report({
              node: alias.id,
              message: `Type alias \`${alias.id.name}\` hides \`unknown\`.`,
            });
          }
        }
      },
    };
  },
};

const noUnsafeDictionary: Deno.lint.Rule = {
  create(context) {
    let env: Environment | null = null;
    const reported = new Set<string>();
    const check = (node: TypeNode) => {
      const currentEnvironment = env;
      if (!currentEnvironment || isPlainAliasConsumer(context, node, currentEnvironment)) return;
      const unsafe = classifyDictionary(node, currentEnvironment);
      if (!unsafe) return;
      const ancestors = context.sourceCode.getAncestors(node);
      if (
        ancestors.some((item) =>
          (item.type === "TSTypeReference" || item.type === "TSTypeLiteral" ||
            item.type === "TSMappedType") &&
          classifyDictionary(item, currentEnvironment) !== null
        )
      ) return;
      const key = node.range.join(":");
      if (!reported.has(key)) {
        reported.add(key);
        context.report({ node, message: `This dictionary's ${unsafe} value type is unsafe.` });
      }
    };
    return {
      Program(program) {
        env = environment(program);
      },
      TSTypeReference: check,
      TSTypeLiteral: check,
      TSMappedType: check,
      TSIndexSignature(node) {
        const currentEnvironment = env;
        if (
          !currentEnvironment || node.parent.type === "TSTypeLiteral" || !node.typeAnnotation
        ) return;
        const unsafe = unsafeValue(
          node.typeAnnotation.typeAnnotation,
          currentEnvironment,
          new Map(),
          new Set(),
        );
        if (unsafe) {
          context.report({ node, message: `This dictionary's ${unsafe} value type is unsafe.` });
        }
      },
    };
  },
};

export const typeAntiSlopRules: Record<string, Deno.lint.Rule> = {
  "no-object-parameters": typeRule("object"),
  "no-unknown-returns": typeRule("returns"),
  "no-unknown-type-aliases": noUnknownAliases,
  "no-unsafe-dictionary-type": noUnsafeDictionary,
};
