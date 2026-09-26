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
      "Open the Patchdesk Review of the checkout that contains cwd, so the maintainer reviews your change in Patchdesk. A new Review reads the checkout as it is now; an existing one is returned on the session the maintainer sees, and refresh_review reads newer changes. It performs no git write. Returns the reviewId, the session (sessionId, headSha, baseSha, patchHash), the changed files, and which Insights are retained. intent is the task you were given, as Markdown; it is recorded only when the Review has no Change intent. With intent, intentRecorded says whether the Review now holds it: intentKept is false when this call recorded it, and true when the Review already held the same text. A refused intent still returns the opened Review, with intentRecorded: false, intentRefused (intent_exists when the Review holds a different intent, in_progress or storage when recording failed and a retry may work), and intentMessage.",
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
  refresh_review: {
    description:
      "Read the checkout of a local Review again after you changed it, and prepare those changes for the maintainer. The Review stays on the session the maintainer sees, and Patchdesk shows them Updates available; their Refresh moves the Review to the prepared session and carries their notes. It performs no git write. Returns changed: false when the checkout still matches the Review's session, else changed: true with preparedSessionId. One call per Review every 10 seconds; an earlier one is refused rate_limited with retryAfterMs.",
    inputSchema: v.strictObject({ reviewId }),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  run_insight: {
    description:
      "Ask the maintainer to run one Insight on a local Review's current session. It returns at once with status awaiting_approval and a requestId; nothing runs until the maintainer presses Run in Patchdesk, and the provider and model are theirs to pick. On awaiting_approval, stop: tell the user the request waits for their approval in Patchdesk, and read get_insight when they resume you. A request already awaiting or running for that session and type is returned as it stands, and a declined one returns declined: the maintainer declined it for this session. sessionId must be the Review's current session, else it is refused stale_session.",
    inputSchema: v.strictObject({
      reviewId,
      sessionId: v.pipe(
        v.string(),
        v.minLength(1),
        v.maxLength(512),
        v.description("The sessionId review_local or get_insight returned."),
      ),
      type: v.picklist(["analysis", "walkthrough", "brief"]),
    }),
    // A repeat after an approved run settles records a new request, so repeats are not idempotent.
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  get_insight: {
    description:
      "Read one Insight of a local Review: its status, and the retained result with the session it describes. awaiting_approval and declined answer a run_insight request on the current session. An Analysis lists its Findings with whether the maintainer dismissed, drafted, or applied each. A result from an earlier session carries outdated: true.",
    inputSchema: v.strictObject({
      reviewId,
      type: v.picklist(["analysis", "walkthrough", "brief"]),
    }),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  get_feedback: {
    description:
      "Read the review comments the maintainer drafted on a local Review, 25 per page in file and line order, with the same Markdown prompt Copy as agent prompt gives. Each comment names the session it was written against and a state: current (written on the Review's current session), unchanged or changed (its lines since it was written), needs_attention (its lines could not be found), or applied. Pass nextCursor to read the next page.",
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
