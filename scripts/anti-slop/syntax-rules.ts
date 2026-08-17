/// <reference lib="deno.unstable" />

// Adapted from dmmulroy/anti-slop revision 446268e5d15baa968eaec669ff65358d36ae6259.

const assertionMessage =
  "This assertion chain discards type evidence. Keep the original precise type, or parse untrusted input at its boundary before narrowing it.";
const typeofMessage =
  "A `typeof` check narrows a representation without establishing its contract. Parse input at its I/O boundary, then branch on the domain value.";
const safetyMessage =
  "This type assertion has no `SAFETY:` justification. State the checked invariant immediately before the assertion or its containing statement.";

type Assertion = Deno.lint.TSAsExpression | Deno.lint.TSTypeAssertion;

function isAssertion(node: Deno.lint.Node): node is Assertion {
  return node.type === "TSAsExpression" || node.type === "TSTypeAssertion";
}

function isConstAssertion(node: Assertion): boolean {
  return node.typeAnnotation.type === "TSTypeReference" &&
    node.typeAnnotation.typeName.type === "Identifier" &&
    node.typeAnnotation.typeName.name === "const";
}

function isOutermostAssertion(node: Assertion): boolean {
  return !isAssertion(node.parent) || node.parent.expression !== node;
}

function isForbiddenChain(node: Assertion): boolean {
  let count = 0;
  let hasNonConst = false;
  let current: Deno.lint.Expression = node;
  while (isAssertion(current)) {
    count++;
    hasNonConst ||= !isConstAssertion(current);
    current = current.expression;
  }
  return count > 1 && hasNonConst;
}

const noChainedTypeAssertions = {
  create(context) {
    const check = (node: Assertion) => {
      if (isOutermostAssertion(node) && isForbiddenChain(node)) {
        context.report({ node, message: assertionMessage });
      }
    };
    return { TSAsExpression: check, TSTypeAssertion: check };
  },
} satisfies Deno.lint.Rule;

const noRuntimeTypeof = {
  create(context) {
    return {
      UnaryExpression(node) {
        if (node.operator === "typeof") context.report({ node, message: typeofMessage });
      },
    };
  },
} satisfies Deno.lint.Rule;

const commentOwners = new Set([
  "ExpressionStatement",
  "PropertyDefinition",
  "ReturnStatement",
  "ThrowStatement",
  "VariableDeclaration",
]);

const requireSafetyComment = {
  create(context) {
    const check = (node: Assertion) => {
      if (isConstAssertion(node)) return;
      const ancestors = context.sourceCode.getAncestors(node);
      const candidates = [node, ...ancestors.toReversed()];
      for (const current of candidates) {
        const justified = context.sourceCode.getCommentsBefore(current).some((comment) =>
          comment.range[1] <= node.range[0] && /\bSAFETY\s*:/u.test(comment.value)
        );
        if (justified) return;
        if (commentOwners.has(current.type) || current.type === "Program") break;
      }
      context.report({ node, message: safetyMessage });
    };
    return { TSAsExpression: check, TSTypeAssertion: check };
  },
} satisfies Deno.lint.Rule;

export const syntaxAntiSlopRules: Record<string, Deno.lint.Rule> = {
  "no-chained-type-assertions": noChainedTypeAssertions,
  "no-runtime-typeof": noRuntimeTypeof,
  "require-safety-comment-for-type-assertion": requireSafetyComment,
};
