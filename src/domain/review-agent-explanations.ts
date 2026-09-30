import { definedProps } from "./defined-props";
import {
  MAX_AGENT_EXPLANATIONS,
  type AgentExplanation,
} from "./agent-explanation";
import type { AgentExplanationId, IsoTimestamp } from "./ids";
import { err, ok, type Result } from "./result";
import { laterTimestamp, type Review } from "./review";
import type { LocalReviewSource } from "./review-source";

/**
 * Add one Agent explanation to a local Review (#665). The same lines and text
 * again return the explanation already stored, so a repeated call adds
 * nothing; any other explanation past the cap is refused. The drafts and the
 * hand-off are left as they are: an explanation is not feedback for the agent.
 */
export function addAgentExplanation(
  review: Review<LocalReviewSource>,
  explanation: AgentExplanation,
): Result<
  {
    readonly review: Review<LocalReviewSource>;
    readonly explanation: AgentExplanation;
  },
  { readonly _tag: "ReviewTerminal" | "ExplanationLimit" }
> {
  if (review.status._tag === "Terminal") return err({ _tag: "ReviewTerminal" });
  const stored = review.agentExplanations ?? [];
  const repeat = stored.find(
    (entry) =>
      entry.sessionId === explanation.sessionId &&
      entry.anchor.path === explanation.anchor.path &&
      entry.anchor.side === explanation.anchor.side &&
      entry.anchor.startLine === explanation.anchor.startLine &&
      entry.anchor.line === explanation.anchor.line &&
      entry.text === explanation.text,
  );
  if (repeat !== undefined) return ok({ review, explanation: repeat });
  if (stored.length >= MAX_AGENT_EXPLANATIONS)
    return err({ _tag: "ExplanationLimit" });
  return ok({
    review: {
      ...review,
      agentExplanations: [...stored, explanation],
      updatedAt: laterTimestamp(review.updatedAt, explanation.createdAt),
    },
    explanation,
  });
}

/** Dismiss one Agent explanation; it is deleted, and dismissing one that is gone changes nothing. */
export function dismissAgentExplanation(
  review: Review<LocalReviewSource>,
  explanationId: AgentExplanationId,
  updatedAt: IsoTimestamp,
): Result<Review<LocalReviewSource>, { readonly _tag: "ReviewTerminal" }> {
  if (review.status._tag === "Terminal") return err({ _tag: "ReviewTerminal" });
  const stored = review.agentExplanations ?? [];
  const kept = stored.filter((entry) => entry.explanationId !== explanationId);
  if (kept.length === stored.length) return ok(review);
  const { agentExplanations: _dismissed, ...rest } = review;
  return ok({
    ...rest,
    ...definedProps({
      agentExplanations: kept.length === 0 ? undefined : kept,
    }),
    updatedAt: laterTimestamp(review.updatedAt, updatedAt),
  });
}
