import * as v from "valibot";

const nonEmpty = v.pipe(v.string(), v.minLength(1));

const reviewId = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(512),
  v.description("The reviewId review_local or list_local_reviews returned."),
);

const cwd = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(4_096),
  v.description(
    "An absolute path inside the checkout, usually your working directory.",
  ),
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
  list_local_reviews: {
    description:
      "List the shared Reviews the maintainer has open for the checkout that contains cwd, in the active Patchdesk profile, the one opened last first. Read-only: it opens, prepares, and moves nothing, takes no snapshot, and does not mark a Review opened. head names the branch the checkout is on. Each entry has the reviewId, branch, baseRef (the base as a full ref, such as refs/heads/main or refs/remotes/origin/main), lastOpenedAt when the maintainer opened it, changeIntent when the Review has a Change intent (kind text with source maintainer or agent, without the text, or kind file with the spec file's path), and the Review's current session (sessionId, headSha, baseSha, patchHash). Use it to find the Review the maintainer means before get_feedback or get_insight. When several entries on your branch differ only by base, ask the maintainer which base they mean. An empty list means no shared Review is open here; review_local opens one. A cwd outside every checkout of the profile is refused checkout_not_found; a repository whose configured checkout no longer exists is refused checkout_missing, naming the path. A Review whose current session is missing is left out. If Patchdesk cannot read the complete saved Review list or a listed Review's current session, it refuses storage rather than leaving that Review out.",
    inputSchema: v.strictObject({ cwd }),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  review_local: {
    description:
      "Open the Patchdesk Review of the checkout that contains cwd, so the maintainer reviews your change in Patchdesk. By default this is the shared Review of the branch checked out there: every change since the branch left its base branch, committed or not, so your commits keep the maintainer's notes in place. Without base, the branch's open shared Review is returned when there is one (the one the maintainer opened last), else Patchdesk infers the base: the other local branch with the fewest commits between its merge base and HEAD, ties going to the default branch. The result names baseRef, the base as a full ref, and baseInferred: true when Patchdesk picked it. A branch with no open Review and no other local branch behind HEAD is refused base_required; pass base. A new Review reads the checkout as it is now; an existing one is returned on the session the maintainer sees, and refresh_review reads newer changes. It changes no branch, index, or working-tree file; Patchdesk stores the snapshot as git objects, a refs/patchdesk/local/ ref, and a worktree in its cache. Returns the reviewId, the session (sessionId, headSha, baseSha, patchHash), the changed files, and which Insights are retained. When the Review has a Change intent, the goal Analysis checks the change against, changeIntent returns it: kind text with source (maintainer or agent) and markdown, or kind file with the path of a spec file to read in your checkout. intent is the task you were given, as Markdown; it is recorded only when the Review has no Change intent. With intent, intentRecorded says whether the Review now holds it: intentKept is false when this call recorded it, and true when the Review already held the same text. A refused intent still returns the opened Review, with intentRecorded: false, intentRefused (intent_exists when the Review holds a different intent, the one changeIntent returns, in_progress or storage when recording failed and a retry may work), and intentMessage. A working tree with more than 5,000 untracked files or 100 MiB of them is refused untracked_too_large before anything is stored; the message names the largest untracked paths to add to .gitignore. A change whose patch is over 2 MiB is refused patch_too_large and no session is stored; the message names the files with the most changes. A cwd in a repository whose configured checkout no longer exists, as after a move on disk, is refused checkout_missing; the message names the configured path.",
    inputSchema: v.strictObject({
      cwd,
      source: v.optional(
        v.pipe(
          v.variant("kind", [
            v.strictObject({ kind: v.literal("local_branch") }),
            v.strictObject({ kind: v.literal("commit"), commit: nonEmpty }),
          ]),
          v.description(
            "What to review; defaults to local_branch, the shared Review of the checked-out branch against its base, with committed, staged, unstaged, and untracked changes. commit reviews one commit against its parent.",
          ),
        ),
      ),
      base: v.optional(
        v.pipe(
          v.string(),
          v.minLength(1),
          v.maxLength(255),
          v.description(
            "The branch the shared Review compares with: a local branch such as main, or a remote-tracking branch such as origin/main as last fetched, since Patchdesk never fetches. A local branch of the same name wins; pass a full ref such as refs/remotes/origin/main to choose. Omit it to reuse the branch's open Review or let Patchdesk infer one. Not allowed with source commit.",
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
      "Read the checkout of a local Review again after you changed it, and prepare those changes for the maintainer. The Review stays on the session the maintainer sees, and Patchdesk shows them Updates available; their Refresh moves the Review to the prepared session and carries their notes. It changes no branch, index, or working-tree file; Patchdesk stores the snapshot as git objects, a refs/patchdesk/local/ ref, and a worktree in its cache. Returns changed: false when the checkout still matches the Review's session, else changed: true with preparedSessionId. One call per Review every 10 seconds; an earlier one is refused rate_limited with retryAfterMs. A working tree over the untracked limit of review_local is refused untracked_too_large, naming the largest untracked paths. A patch over 2 MiB is refused patch_too_large, naming the files with the most changes. A Review whose configured checkout no longer exists is refused checkout_missing, naming the path.",
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
        v.description(
          "The sessionId review_local, list_local_reviews, or get_insight returned.",
        ),
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
  show_review: {
    description:
      "Switch the Patchdesk window to an existing Review, so the maintainer finds it on screen the next time they switch to Patchdesk. It never raises or focuses the window, and it does not create or refresh a Review. It shows any saved Review of the active profile, local or pull request, even one whose repository is no longer watched. Returns status shown, or held when unsent review text (a half-written note, comment, or reply, a review summary, or an unsaved Change intent edit) or a GitHub write in progress keeps Patchdesk on its current screen; on held nothing moved, so tell the user the Review is ready for them to open. A reviewId the active profile does not hold is refused not_found, or profile_changed when another profile holds it. A shared Review whose checkout is now on another branch is refused branch_mismatch, naming that branch.",
    inputSchema: v.strictObject({ reviewId }),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  get_feedback: {
    description:
      "Read the review comments the maintainer drafted on a local Review in file and line order, up to 25 per page and fewer when they are long, with the same Markdown prompt Copy as agent prompt gives. Each comment names the session it was written against, the view it was written in (combined, committed, or uncommitted; its path, side, and lines are numbered in that view), inline (true when those lines sit inside a hunk of that view on the Review's current session), and a state: current (written on the Review's current session), unchanged or changed (its lines since it was written), needs_attention (its lines could not be found), or applied. Pass nextCursor to read the next page.",
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
  get_review_status: {
    description:
      "Read where a local Review stands in one call. Returns the Review's current session (sessionId, headSha, baseSha, patchHash); preparedSessionId while a session your refresh_review prepared waits for the maintainer's Refresh, absent once their Refresh has moved the Review to it; for each Insight (analysis, walkthrough, brief) the status and requestId get_insight reports; localDraftCounts, how many of the maintainer's drafts of each kind (finding, note) are in each state get_feedback reports (current, unchanged, changed, needs_attention, applied); and appliedFindings, the Findings whose suggestion the maintainer's Apply wrote to your checkout, each with findingId, title, path, startLine and line (new-side lines of the session it was drafted on), and appliedAt. It returns no Insight result and no draft text; get_insight and get_feedback read those. Read-only: it takes no snapshot and does not mark the Review opened. A reviewId the active profile does not hold is refused not_found, or profile_changed when another profile holds it; a pull request Review is refused not_applicable.",
    inputSchema: v.strictObject({ reviewId }),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
} as const;

export type McpToolName = keyof typeof mcpToolManifest;

export function isMcpToolName(name: string): name is McpToolName {
  return Object.hasOwn(mcpToolManifest, name);
}

export const mcpToolNames: ReadonlyArray<McpToolName> =
  Object.keys(mcpToolManifest).filter(isMcpToolName);
