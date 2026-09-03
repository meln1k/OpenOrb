/// <reference lib="deno.unstable" />

// OpenOrb-specific Result and error-boundary policies.
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type Node = Deno.lint.Node;
type Expression = Deno.lint.Expression;
type Statement = Deno.lint.Statement;
type TypeNode = Deno.lint.TSTypeAnnotation["typeAnnotation"];

interface UnknownNode {
  readonly [key: string]: unknown;
}

interface ResultEnvironment {
  readonly resultTypeNames: Set<string>;
  readonly aliases: Map<string, TypeNode>;
  readonly producerKinds: Map<string, ResultKind>;
  readonly methodKinds: Map<string, ResultKind>;
  readonly bindingKinds: Map<string, ResultKind>;
}

type ResultKind =
  | "result"
  | "promise-result"
  | "result-array"
  | "promise-result-array"
  | "pending-result-array";

type ErrorGuard = {
  readonly failure: Statement;
};

const RESULT_PACKAGE = "@openorb/result";
const APPLICATION_PATHS = [
  "packages/gateway/app/",
  "packages/protocol/src/",
  "packages/runner/src/",
];

function normalizedPath(filename: string): string {
  return filename.replaceAll("\\", "/");
}

function isApplicationFile(filename: string): boolean {
  const path = normalizedPath(filename);
  return APPLICATION_PATHS.some((part) => path.includes(part)) ||
    path.endsWith("packages/gateway/server.ts");
}

function isApplicationTestFile(filename: string): boolean {
  const path = normalizedPath(filename);
  return path.includes("/test/") || /\.(?:test|bench)\.[cm]?[jt]sx?$/.test(path);
}

function isBrowserFile(filename: string): boolean {
  const path = normalizedPath(filename);
  return path.includes("packages/gateway/app/ui/") ||
    path.endsWith("packages/gateway/app/assets/client.ts");
}

function isResultPackage(source: Deno.lint.ImportDeclaration["source"]): boolean {
  return source.value === RESULT_PACKAGE;
}

function resolveFirstPartyImport(filename: string, specifier: string): string | null {
  const importer = filename.startsWith("file:") ? fileURLToPath(filename) : resolve(filename);
  if (specifier.startsWith("@/")) {
    const packageMatch = normalizedPath(importer).match(/^(.*\/packages\/[^/]+)\//);
    const packageRoot = packageMatch?.[1];
    return packageRoot === undefined ? null : resolve(packageRoot, specifier.slice(2));
  }
  return specifier.startsWith("./") || specifier.startsWith("../")
    ? resolve(dirname(importer), specifier)
    : null;
}

function skipQuoted(source: string, start: number): number {
  const quote = source[start];
  for (let index = start + 1; index < source.length; index += 1) {
    if (source[index] === "\\") index += 1;
    else if (source[index] === quote) return index + 1;
  }
  return source.length;
}

function skipComment(source: string, start: number): number | null {
  if (source[start] !== "/") return null;
  if (source[start + 1] === "/") {
    const end = source.indexOf("\n", start + 2);
    return end === -1 ? source.length : end + 1;
  }
  if (source[start + 1] === "*") {
    const end = source.indexOf("*/", start + 2);
    return end === -1 ? source.length : end + 2;
  }
  return null;
}

function skipTrivia(source: string, start: number): number {
  let index = start;
  while (index < source.length) {
    if (/\s/.test(source[index] ?? "")) {
      index += 1;
      continue;
    }
    const commentEnd = skipComment(source, index);
    if (commentEnd === null) break;
    index = commentEnd;
  }
  return index;
}

function parameterListStart(source: string, start: number): number | null {
  let typeParameterDepth = 0;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (character === '"' || character === "'" || character === "`") {
      index = skipQuoted(source, index) - 1;
      continue;
    }
    const commentEnd = skipComment(source, index);
    if (commentEnd !== null) {
      index = commentEnd - 1;
      continue;
    }
    if (character === "<") typeParameterDepth += 1;
    else if (character === ">") typeParameterDepth -= 1;
    else if (character === "(" && typeParameterDepth === 0) return index;
    else if (character === "{" || character === ";") return null;
  }
  return null;
}

function parameterListEnd(source: string, start: number): number | null {
  let depth = 0;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (character === '"' || character === "'" || character === "`") {
      index = skipQuoted(source, index) - 1;
      continue;
    }
    const commentEnd = skipComment(source, index);
    if (commentEnd !== null) {
      index = commentEnd - 1;
      continue;
    }
    if (character === "(") depth += 1;
    else if (character === ")" && --depth === 0) return index;
  }
  return null;
}

// Deno's lint API has no cross-module type information. Read first-party
// declarations so an explicit Result return type is the only registry needed.
function exportedResultKind(source: string, exportedName: string): ResultKind | null {
  const escapedName = exportedName.replaceAll(/[$]/g, "\\$");
  const declaration = new RegExp(
    `\\bexport\\s+(async\\s+)?function\\s+${escapedName}\\b`,
    "g",
  );
  for (const match of source.matchAll(declaration)) {
    const parametersStart = parameterListStart(source, (match.index ?? 0) + match[0].length);
    if (parametersStart === null) continue;
    const parametersEnd = parameterListEnd(source, parametersStart);
    if (parametersEnd === null) continue;
    const annotationStart = skipTrivia(source, parametersEnd + 1);
    if (source[annotationStart] !== ":") continue;
    const annotation = source.slice(skipTrivia(source, annotationStart + 1));
    if (/^Result\s*</.test(annotation)) return "result";
    if (/^Promise\s*<\s*Result\s*</.test(annotation)) return "promise-result";
  }
  return null;
}

function readFirstPartyModule(
  filename: string,
  source: string,
): string | null {
  const path = resolveFirstPartyImport(filename, source);
  return path !== null && existsSync(path) ? Deno.readTextFileSync(path) : null;
}

function isNode(value: unknown): value is Node {
  return typeof value === "object" && value !== null && "type" in value &&
    typeof value.type === "string";
}

function children(node: Node): Node[] {
  const result: Node[] = [];
  const record = node as unknown as UnknownNode;
  for (const key in record) {
    if (key === "parent" || key === "range" || key === "loc") continue;
    const value = record[key];
    if (isNode(value)) result.push(value);
    else if (Array.isArray(value)) {
      for (const item of value) if (isNode(item)) result.push(item);
    }
  }
  return result;
}

function walk(node: Node, visit: (child: Node) => void): void {
  visit(node);
  for (const child of children(node)) walk(child, visit);
}

function typeName(type: TypeNode): string | null {
  return type.type === "TSTypeReference" && type.typeName.type === "Identifier"
    ? type.typeName.name
    : null;
}

function resultKind(
  type: TypeNode,
  environment: ResultEnvironment,
  resolving = new Set<string>(),
): ResultKind | null {
  if (type.type === "TSUnionType" || type.type === "TSIntersectionType") {
    for (const member of type.types) {
      const kind = resultKind(member, environment, resolving);
      if (kind !== null) return kind;
    }
    return null;
  }
  if (type.type === "TSArrayType") {
    const elementKind = resultKind(type.elementType, environment, resolving);
    return elementKind === "result"
      ? "result-array"
      : elementKind === "promise-result"
      ? "pending-result-array"
      : null;
  }
  const name = typeName(type);
  if (name === null || resolving.has(name)) return null;
  if (environment.resultTypeNames.has(name)) return "result";
  if (name === "Array" || name === "ReadonlyArray") {
    const element = type.type === "TSTypeReference" ? type.typeArguments?.params[0] : undefined;
    const elementKind = element === undefined ? null : resultKind(element, environment, resolving);
    return elementKind === "result"
      ? "result-array"
      : elementKind === "promise-result"
      ? "pending-result-array"
      : null;
  }
  if (name === "Promise" || name === "PromiseLike") {
    const inner = type.type === "TSTypeReference" ? type.typeArguments?.params[0] : undefined;
    if (inner === undefined) return null;
    const innerKind = resultKind(inner, environment, resolving);
    return innerKind === "result"
      ? "promise-result"
      : innerKind === "result-array"
      ? "promise-result-array"
      : innerKind === "pending-result-array"
      ? "pending-result-array"
      : null;
  }
  const alias = environment.aliases.get(name);
  if (alias === undefined) return null;
  const next = new Set(resolving);
  next.add(name);
  return resultKind(alias, environment, next);
}

function propertyName(
  node: Deno.lint.MemberExpression | Deno.lint.MethodDefinition,
): string | null {
  const property = node.type === "MemberExpression" ? node.property : node.key;
  if (property.type === "Identifier" || property.type === "PrivateIdentifier") return property.name;
  return property.type === "Literal" && typeof property.value === "string" ? property.value : null;
}

function signatureName(node: Deno.lint.TSMethodSignature): string | null {
  return node.key.type === "Identifier"
    ? node.key.name
    : node.key.type === "Literal" && typeof node.key.value === "string"
    ? node.key.value
    : null;
}

function functionReturnType(node: Node): TypeNode | null {
  if (
    node.type === "ArrowFunctionExpression" || node.type === "FunctionDeclaration" ||
    node.type === "FunctionExpression" || node.type === "TSDeclareFunction" ||
    node.type === "TSEmptyBodyFunctionExpression"
  ) return node.returnType?.typeAnnotation ?? null;
  return null;
}

function initializeEnvironment(
  program: Deno.lint.Program,
  filename: string,
): ResultEnvironment {
  const environment: ResultEnvironment = {
    resultTypeNames: new Set(["Result"]),
    aliases: new Map(),
    producerKinds: new Map(),
    methodKinds: new Map(),
    bindingKinds: new Map(),
  };

  walk(program, (node) => {
    if (node.type === "ImportDeclaration") {
      if (isResultPackage(node.source)) {
        for (const specifier of node.specifiers) {
          if (specifier.type !== "ImportSpecifier" || specifier.imported.type !== "Identifier") {
            continue;
          }
          if (specifier.imported.name === "Result") {
            environment.resultTypeNames.add(specifier.local.name);
          } else if (["ok", "err", "trySync"].includes(specifier.imported.name)) {
            environment.producerKinds.set(specifier.local.name, "result");
          } else if (specifier.imported.name === "tryAsync") {
            environment.producerKinds.set(specifier.local.name, "promise-result");
          }
        }
      }
      const importedSource = readFirstPartyModule(filename, node.source.value);
      for (const specifier of node.specifiers) {
        if (specifier.type !== "ImportSpecifier" || specifier.imported.type !== "Identifier") {
          continue;
        }
        const kind = importedSource === null
          ? null
          : exportedResultKind(importedSource, specifier.imported.name);
        if (kind !== null) environment.producerKinds.set(specifier.local.name, kind);
      }
    } else if (node.type === "TSTypeAliasDeclaration") {
      environment.aliases.set(node.id.name, node.typeAnnotation);
    }
  });

  walk(program, (node) => {
    if (
      (node.type === "FunctionDeclaration" || node.type === "TSDeclareFunction") && node.id &&
      node.returnType
    ) {
      const kind = resultKind(node.returnType.typeAnnotation, environment);
      if (kind !== null) environment.producerKinds.set(node.id.name, kind);
    } else if (
      node.type === "MethodDefinition" && node.value.returnType
    ) {
      const name = propertyName(node);
      const kind = resultKind(node.value.returnType.typeAnnotation, environment);
      if (name !== null && kind !== null) environment.methodKinds.set(name, kind);
    } else if (
      node.type === "TSMethodSignature" && node.returnType
    ) {
      const name = signatureName(node);
      const kind = resultKind(node.returnType.typeAnnotation, environment);
      if (name !== null && kind !== null) environment.methodKinds.set(name, kind);
    } else if (node.type === "VariableDeclarator" && node.id.type === "Identifier") {
      const annotation = node.id.typeAnnotation?.typeAnnotation;
      const annotationKind = annotation === undefined ? null : resultKind(annotation, environment);
      if (annotationKind !== null) {
        environment.bindingKinds.set(node.id.name, annotationKind);
      }
      const returned = node.init === null ? null : functionReturnType(node.init);
      const returnedKind = returned === null ? null : resultKind(returned, environment);
      if (returnedKind !== null) {
        environment.producerKinds.set(node.id.name, returnedKind);
      }
      if (annotation?.type === "TSFunctionType" && annotation.returnType) {
        const kind = resultKind(annotation.returnType.typeAnnotation, environment);
        if (kind !== null) environment.producerKinds.set(node.id.name, kind);
      }
    } else if (
      node.type === "Identifier" && node.typeAnnotation &&
      resultKind(node.typeAnnotation.typeAnnotation, environment) !== null
    ) {
      const kind = resultKind(node.typeAnnotation.typeAnnotation, environment);
      if (kind !== null) environment.bindingKinds.set(node.name, kind);
    }
  });
  return environment;
}

function unwrapExpression(expression: Expression): Expression {
  let current = expression;
  while (
    current.type === "AwaitExpression" || current.type === "ChainExpression" ||
    current.type === "TSAsExpression" || current.type === "TSTypeAssertion" ||
    current.type === "TSSatisfiesExpression" || current.type === "TSNonNullExpression"
  ) {
    if (current.type === "AwaitExpression") current = current.argument;
    else current = current.expression;
  }
  return current;
}

function expressionResultKind(
  expression: Expression,
  environment: ResultEnvironment,
): ResultKind | null {
  if (expression.type === "AwaitExpression") {
    const awaited = expressionResultKind(expression.argument, environment);
    return awaited === "promise-result"
      ? "result"
      : awaited === "promise-result-array"
      ? "result-array"
      : awaited;
  }
  if (
    expression.type === "ChainExpression" || expression.type === "TSAsExpression" ||
    expression.type === "TSTypeAssertion" || expression.type === "TSSatisfiesExpression" ||
    expression.type === "TSNonNullExpression"
  ) return expressionResultKind(expression.expression, environment);

  const value = expression;
  if (value.type === "Identifier") {
    return environment.bindingKinds.get(value.name) ?? null;
  }
  if (value.type === "ConditionalExpression") {
    const consequent = expressionResultKind(value.consequent, environment);
    const alternate = expressionResultKind(value.alternate, environment);
    return consequent !== null && consequent === alternate ? consequent : null;
  }
  if (value.type === "SequenceExpression") {
    const final = value.expressions.at(-1);
    return final === undefined ? null : expressionResultKind(final, environment);
  }
  if (value.type === "ArrayExpression") {
    if (value.elements.length === 0) return null;
    let pending = false;
    for (const element of value.elements) {
      if (element === null || element.type === "SpreadElement") return null;
      const kind = expressionResultKind(element, environment);
      if (kind === "promise-result") pending = true;
      else if (kind !== "result") return null;
    }
    return pending ? "pending-result-array" : "result-array";
  }
  if (value.type === "MemberExpression") {
    if (value.object.type === "Super") return null;
    const objectKind = expressionResultKind(value.object, environment);
    if (!value.computed || objectKind !== "result-array") return null;
    if (value.property.type === "PrivateIdentifier") return null;
    const property = unwrapExpression(value.property);
    return property.type === "Literal" && typeof property.value === "number" ? "result" : null;
  }
  if (value.type !== "CallExpression") return null;
  const callee = unwrapExpression(value.callee);
  if (callee.type === "Identifier") return environment.producerKinds.get(callee.name) ?? null;
  if (callee.type === "MemberExpression") {
    const name = propertyName(callee);
    if (
      name === "all" && callee.object.type === "Identifier" && callee.object.name === "Promise"
    ) {
      const argument = value.arguments[0];
      if (argument === undefined || argument.type === "SpreadElement") return null;
      const argumentKind = expressionResultKind(argument, environment);
      return argumentKind === "result-array" || argumentKind === "pending-result-array"
        ? "promise-result-array"
        : null;
    }
    if (name === "find" && callee.object.type !== "Super") {
      return expressionResultKind(callee.object, environment) === "result-array" ? "result" : null;
    }
    return name === null ? null : environment.methodKinds.get(name) ?? null;
  }
  const returned = functionReturnType(callee);
  return returned === null ? null : resultKind(returned, environment);
}

function isErrorName(name: string): boolean {
  return /error$/i.test(name);
}

function nextStatement(declaration: Deno.lint.VariableDeclaration): Node | null {
  const parent = declaration.parent;
  const body = parent.type === "Program" || parent.type === "BlockStatement"
    ? parent.body
    : parent.type === "SwitchCase"
    ? parent.consequent
    : null;
  if (body === null) return null;
  const index = body.findIndex((candidate) => candidate === declaration);
  return body[index + 1] ?? null;
}

function undefinedComparison(
  expression: Expression,
  errorName: string,
): "equal" | "not-equal" | null {
  const value = unwrapExpression(expression);
  if (value.type !== "BinaryExpression" || (value.operator !== "===" && value.operator !== "!==")) {
    return null;
  }
  if (value.left.type === "PrivateIdentifier") return null;
  const left = unwrapExpression(value.left);
  const right = unwrapExpression(value.right);
  const matches = left.type === "Identifier" && left.name === errorName &&
      right.type === "Identifier" && right.name === "undefined" ||
    right.type === "Identifier" && right.name === errorName &&
      left.type === "Identifier" && left.name === "undefined";
  if (!matches) return null;
  return value.operator === "===" ? "equal" : "not-equal";
}

function errorGuard(statement: Node | null, errorName: string): ErrorGuard | null {
  if (statement?.type !== "IfStatement") return null;
  const comparison = undefinedComparison(statement.test, errorName);
  if (comparison === "not-equal") {
    return { failure: statement.consequent };
  }
  if (comparison === "equal" && statement.alternate !== null) {
    return { failure: statement.alternate };
  }
  return null;
}

function statementsTerminate(statements: readonly Statement[]): boolean {
  return statements.some(statementTerminates);
}

function statementTerminates(statement: Statement): boolean {
  if (
    statement.type === "ReturnStatement" || statement.type === "ThrowStatement" ||
    statement.type === "ContinueStatement"
  ) return true;
  if (statement.type === "BlockStatement") return statementsTerminate(statement.body);
  if (statement.type === "LabeledStatement") return statementTerminates(statement.body);
  if (statement.type === "IfStatement") {
    return statement.alternate !== null && statementTerminates(statement.consequent) &&
      statementTerminates(statement.alternate);
  }
  if (statement.type === "TryStatement") {
    if (statement.finalizer && statementTerminates(statement.finalizer)) return true;
    return statementTerminates(statement.block) &&
      (statement.handler === null || statementTerminates(statement.handler.body));
  }
  return false;
}

function isReference(identifier: Deno.lint.Identifier): boolean {
  const parent = identifier.parent;
  if (
    parent.type === "MemberExpression" && parent.property === identifier && !parent.computed ||
    parent.type === "Property" && parent.key === identifier && !parent.computed &&
      parent.value !== identifier ||
    parent.type === "MethodDefinition" && parent.key === identifier && !parent.computed ||
    parent.type === "VariableDeclarator" && parent.id === identifier ||
    parent.type === "FunctionDeclaration" && parent.id === identifier
  ) return false;
  return true;
}

function referencesValue(statement: Statement, valueName: string): boolean {
  let referenced = false;
  walk(statement, (node) => {
    if (node.type === "Identifier" && node.name === valueName && isReference(node)) {
      referenced = true;
    }
  });
  return referenced;
}

const requireResultHandling: Deno.lint.Rule = {
  create(context) {
    if (!isApplicationFile(context.filename)) return {};
    let environment: ResultEnvironment | null = null;

    return {
      Program(program) {
        environment = initializeEnvironment(program, context.filename);
      },
      VariableDeclarator(node) {
        const current = environment;
        if (current === null || node.init === null) return;
        const expressionKind = expressionResultKind(node.init, current);
        const knownResult = expressionKind === "result";

        if (expressionKind === "result-array") {
          if (node.id.type === "Identifier") {
            current.bindingKinds.set(node.id.name, expressionKind);
          }
          context.report({
            node,
            message:
              "Do not retain an aggregate containing Results; destructure each Result when it settles.",
          });
          return;
        }

        if (node.id.type === "Identifier") {
          const explicitKind = node.id.typeAnnotation === undefined
            ? null
            : resultKind(node.id.typeAnnotation.typeAnnotation, current);
          const pendingKind = expressionKind === "promise-result" ||
              expressionKind === "promise-result-array" ||
              expressionKind === "pending-result-array"
            ? expressionKind
            : explicitKind === "promise-result" || explicitKind === "promise-result-array" ||
                explicitKind === "pending-result-array"
            ? explicitKind
            : null;
          if (pendingKind !== null) {
            current.bindingKinds.set(node.id.name, pendingKind);
            return;
          }
          const explicitResult = explicitKind === "result";
          if (!knownResult && !explicitResult) return;
          current.bindingKinds.set(node.id.name, "result");
          context.report({
            node,
            message: "Destructure a Result immediately instead of retaining its container.",
          });
          return;
        }
        if (node.id.type !== "ArrayPattern") return;
        const errorElement = node.id.elements[1];
        const omittedValueMatch = node.id.elements.length === 0
          ? /^\[\s*,\s*([A-Za-z_$][\w$]*)\s*\]$/u.exec(
            context.sourceCode.text.slice(node.id.range[0], node.id.range[1]),
          )
          : null;
        const errorName = errorElement?.type === "Identifier"
          ? errorElement.name
          : omittedValueMatch?.[1] ?? null;
        if (!knownResult && (errorName === null || !isErrorName(errorName))) return;

        if (
          node.parent.kind !== "const" || node.parent.declarations.length !== 1 ||
          (omittedValueMatch === null &&
            (node.id.elements.length !== 2 || node.id.elements[0]?.type !== "Identifier")) ||
          errorName === null
        ) {
          context.report({
            node: node.id,
            message: "A Result must be declared as one const [value, error] destructure.",
          });
          return;
        }

        const guard = errorGuard(nextStatement(node.parent), errorName);
        if (guard === null) {
          context.report({
            node,
            message:
              `Guard \`${errorName}\` against undefined in the statement immediately after this Result.`,
          });
          return;
        }
        if (!statementTerminates(guard.failure)) {
          context.report({
            node: guard.failure,
            message:
              `The \`${errorName}\` failure branch must terminate control flow on every path.`,
          });
        }
        const valueElement = node.id.elements[0];
        if (
          valueElement?.type === "Identifier" &&
          referencesValue(guard.failure, valueElement.name)
        ) {
          context.report({
            node: guard.failure,
            message: `Do not use \`${valueElement.name}\` while \`${errorName}\` is present.`,
          });
        }
      },
      MemberExpression(node) {
        if (!node.computed || environment === null) return;
        if (node.property.type === "PrivateIdentifier") return;
        const property = unwrapExpression(node.property);
        if (
          property.type !== "Literal" || (property.value !== 0 && property.value !== 1) ||
          expressionResultKind(node.object, environment) !== "result"
        ) return;
        context.report({
          node,
          message: "Destructure Results; do not access tuple slots by index.",
        });
      },
    };
  },
};

const noGenericErrorThrow: Deno.lint.Rule = {
  create(context) {
    if (!isApplicationFile(context.filename) || isApplicationTestFile(context.filename)) return {};
    return {
      ThrowStatement(node) {
        const argument = unwrapExpression(node.argument);
        if (
          (argument.type === "NewExpression" || argument.type === "CallExpression") &&
          argument.callee.type === "Identifier" &&
          argument.callee.name === "Error"
        ) {
          context.report({
            node,
            message: "Return a Result with a meaningful domain error instead of throwing Error.",
          });
        }
      },
    };
  },
};

const noCatch: Deno.lint.Rule = {
  create(context) {
    if (
      !isApplicationFile(context.filename) || isApplicationTestFile(context.filename) ||
      isBrowserFile(context.filename)
    ) return {};
    return {
      CatchClause(node) {
        context.report({
          node,
          message: "Use tryAsync or trySync at the exception boundary instead of catch.",
        });
      },
    };
  },
};

export const resultRules = {
  "require-result-handling": requireResultHandling,
  "no-generic-error-throw": noGenericErrorThrow,
  "no-catch": noCatch,
} satisfies Record<string, Deno.lint.Rule>;
