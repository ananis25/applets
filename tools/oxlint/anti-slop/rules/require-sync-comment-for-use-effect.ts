import { defineRule } from "@oxlint/plugins";

import type { ESTree, SourceCode } from "@oxlint/plugins";

const MARKER = /(?:^|[^\p{L}\p{N}_])SYNC\s*:\s*\S/u;

const effectHooks = new Set(["useEffect", "useLayoutEffect", "useInsertionEffect"]);

const commentOwnerKinds = new Set([
  "ExpressionStatement",
  "ReturnStatement",
  "VariableDeclaration",
]);

function hookName(callee: ESTree.Node): string | null {
  if (callee.type === "Identifier") return callee.name;
  if (callee.type === "MemberExpression" && callee.property.type === "Identifier") {
    return callee.property.name;
  }
  return null;
}

function hasCommentBefore(sourceCode: SourceCode, owner: ESTree.Node, call: ESTree.Node): boolean {
  return sourceCode
    .getCommentsBefore(owner)
    .some((comment) => comment.end <= call.start && MARKER.test(comment.value));
}

/** The call itself, then each enclosing node up to the statement that holds it, may carry the comment. */
function hasSyncComment(sourceCode: SourceCode, call: ESTree.CallExpression): boolean {
  let current: ESTree.Node = call;
  while (true) {
    if (hasCommentBefore(sourceCode, current, call)) return true;
    if (commentOwnerKinds.has(current.type) || current.parent.type === "Program") return false;
    current = current.parent;
  }
}

/**
 * Require every effect hook to name the system outside React it keeps in sync. Effects that fetch,
 * derive state from state, or react to an event have a better home, and the comment makes the
 * remaining ones say why they are effects.
 */
export const requireSyncCommentForUseEffectRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Require a SYNC comment naming the external system for every useEffect, useLayoutEffect and useInsertionEffect.",
    },
    messages: {
      missingSyncComment:
        "`{{hook}}` has no `SYNC:` comment. Effects are for syncing with a system outside React; name it (`// SYNC: the document's keydown listener`). Otherwise move the work: fetching to a query, derived values to render, responses to an event handler.",
    },
    schema: [],
  },
  createOnce(context) {
    return {
      CallExpression(node) {
        const hook = hookName(node.callee);
        if (hook === null || !effectHooks.has(hook)) return;
        if (hasSyncComment(context.sourceCode, node)) return;
        context.report({ node, messageId: "missingSyncComment", data: { hook } });
      },
    };
  },
});
