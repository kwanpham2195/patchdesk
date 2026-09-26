import * as v from "valibot";

const nonEmpty = v.pipe(v.string(), v.minLength(1));

const reviewId = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(512),
  v.description("The reviewId review_local returned."),
);

/**
 * The tools the shim registers (ADR 0052 "Tools, v1"). The app's dispatcher
 * in `src/main/mcp/mcp-tool-dispatcher.ts` is keyed by the same names and
 * re-validates each call with the same schema.
 */
export const mcpToolManifest = {
  list_repositories: {
    description:
      "List the repositories of the active Patchdesk workspace profile that have a local checkout, with each live checkout (the configured one and its linked worktrees) and the branch it is on. Reads local git only.",
    inputSchema: v.strictObject({}),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  review_local: {
    description:
      "Open, or reuse, the Patchdesk Review of the checkout that contains cwd, so the maintainer reviews your change in Patchdesk. Reads the checkout as it is now; it performs no git write. Returns the reviewId, the session (sessionId, headSha, baseSha, patchHash), the changed files, and which Insights are retained. intent is the task you were given, as Markdown; it is recorded only when the Review has no Change intent. intentKept is false when this call recorded the intent, and true when the Review already held the same text.",
    inputSchema: v.strictObject({
      cwd: v.pipe(
        v.string(),
        v.minLength(1),
        v.maxLength(4_096),
        v.description(
          "An absolute path inside the checkout, usually your working directory.",
        ),
      ),
      source: v.optional(
        v.pipe(
          v.variant("kind", [
            v.strictObject({ kind: v.literal("working_tree") }),
            v.strictObject({
              kind: v.literal("branch"),
              branch: nonEmpty,
              baseBranch: nonEmpty,
            }),
            v.strictObject({ kind: v.literal("commit"), commit: nonEmpty }),
          ]),
          v.description(
            "What to review; defaults to the working tree, which includes uncommitted and untracked changes.",
          ),
        ),
      ),
      intent: v.optional(
        v.pipe(
          v.string(),
          v.minLength(1),
          v.maxLength(65_536),
          v.description(
            "The goal of the change as Markdown, for Analysis to check the patch against.",
          ),
        ),
      ),
    }),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  get_insight: {
    description:
      "Read one Insight of a local Review: its status, and the retained result with the session it describes. An Analysis lists its Findings with whether the maintainer dismissed, drafted, or applied each. A result from an earlier session carries outdated: true.",
    inputSchema: v.strictObject({
      reviewId,
      type: v.picklist(["analysis", "walkthrough", "brief"]),
    }),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  get_feedback: {
    description:
      "Read the review comments the maintainer drafted on a local Review, 25 per page in file and line order, with the same Markdown prompt Copy as agent prompt gives. Each comment names the session it was written against and whether its lines changed since. Pass nextCursor to read the next page.",
    inputSchema: v.strictObject({
      reviewId,
      cursor: v.optional(
        v.pipe(
          v.string(),
          v.minLength(1),
          v.maxLength(64),
          v.description("The nextCursor of the previous page."),
        ),
      ),
    }),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
} as const;

export type McpToolName = keyof typeof mcpToolManifest;

export function isMcpToolName(name: string): name is McpToolName {
  return Object.hasOwn(mcpToolManifest, name);
}

export const mcpToolNames: ReadonlyArray<McpToolName> =
  Object.keys(mcpToolManifest).filter(isMcpToolName);
