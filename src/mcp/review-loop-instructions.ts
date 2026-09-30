/**
 * How a coding agent runs the review loop with Patchdesk's tools. The server
 * sends it as MCP `instructions` at connect (#701), and `pnpm docs:mcp-tools`
 * writes it into the "Review in Patchdesk" block of `docs/mcp.md`.
 */
const reviewLoopSteps = [
  "- To get an Analysis, Walkthrough, or Brief, call `run_insight` with the `reviewId` and `sessionId` from `review_local`. It returns `awaiting_approval`: stop, and tell the user the request waits for their approval in Patchdesk. Call `get_insight` when the user says it ran.",
  "- Before `get_feedback`, call `list_local_reviews` with your working directory as `cwd` to find the Review the user is looking at, and use its `reviewId`. If it returns several Reviews for your branch, ask the user which base they meant.",
  '- When the user says "check Patchdesk", call `get_insight` for any Insight you requested, then `get_feedback` with `open: true`; address every Finding and comment, and answer each comment with `reply_to_note`: `addressed`, `skipped` with the reason, or `question`. Then call `refresh_review` and tell the user the changes are ready. To get an Insight on the new code, call `run_insight` with the `preparedSessionId` from `refresh_review`; on `awaiting_refresh`, tell the user to press Refresh in Patchdesk.',
] as const;

/**
 * The server sends only the on-request trigger, so registering Patchdesk does
 * not make an agent open a Review for every change; the pasted block's first
 * bullet opts a project into that.
 */
export const reviewLoopInstructions = [
  "Patchdesk is the user's review desk for your changes. The user stays the reviewer: an Insight runs only after they press Run, and the Review moves to your newer code only when they press Refresh.",
  "",
  "- When the user asks for a review in Patchdesk, call `review_local` with your working directory as `cwd` and the task you were given as `intent`.",
  ...reviewLoopSteps,
].join("\n");

/** The block `docs/mcp.md` offers for `AGENTS.md`: this opt-in, then the steps. */
const reviewOnEveryChange =
  "- When a change is ready for review, call the Patchdesk tool `review_local` with your working directory as `cwd` and the task you were given as `intent`.";

export const agentInstructionsBlock = [
  "## Review in Patchdesk",
  "",
  reviewOnEveryChange,
  ...reviewLoopSteps,
].join("\n");
