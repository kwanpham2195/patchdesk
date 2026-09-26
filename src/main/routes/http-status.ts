import type { Context } from "hono";

import type { FailureKind, FailureKinds } from "../../domain/failure-kind";
import {
  insightFailureKinds,
  type InsightCoordinatorFailure,
} from "../../services/insight-run-coordinator";

/**
 * The eight write-failure reasons every review write route shares.
 * `LabelWriteFailure`, `AssigneeWriteFailure`, `ReviewerWriteFailure` and
 * `DirectConversationFailure` all contain exactly these; each service's own
 * extra reasons stay out of this union and travel in `overrides` instead.
 */
type ReviewWriteFailureReason =
  | "invalid_input"
  | "not_found"
  | "permission_denied"
  | "forbidden"
  | "github_read_failed"
  | "github_write_failed"
  | "outcome_unknown"
  | "rate_limited"
  | "review_write_in_progress";

/** The HTTP statuses a refused review write answers with. */
type ReviewWriteFailureStatus = 400 | 403 | 404 | 409 | 503;

type SharedReviewWriteFailureStatuses = {
  readonly [Reason in ReviewWriteFailureReason]: ReviewWriteFailureStatus;
};

const sharedReviewWriteFailureStatus: SharedReviewWriteFailureStatuses = {
  not_found: 404,
  // `forbidden` is GitHub refusing the account; `permission_denied` is this
  // Review's own write gate refusing the attempt (see each service's
  // `mapGateFailure`), a conflict refreshing clears — hence 409, not 403.
  forbidden: 403,
  permission_denied: 409,
  review_write_in_progress: 409,
  outcome_unknown: 409,
  github_read_failed: 503,
  github_write_failed: 503,
  rate_limited: 503,
  // A rule the service enforces locally, before contacting GitHub at all.
  invalid_input: 400,
};

/**
 * Maps one review write failure to its status, so the four write routes
 * answer the shared reasons identically. `overrides` carries the reasons only
 * one service can report; the compiler demands an entry for every reason the
 * caller's union holds beyond the shared eight, so a new reason on any of
 * those services fails the build here instead of falling through to 400.
 */
export function mapReviewWriteFailureStatus<Extra extends string = never>(
  // `NoInfer` reads `Extra` off `overrides` alone; inferring it from the
  // reason would let an unlisted reason widen `Extra` to itself and pass.
  reason: ReviewWriteFailureReason | NoInfer<Extra>,
  overrides: Readonly<Record<Extra, ReviewWriteFailureStatus>>,
): ReviewWriteFailureStatus {
  const statuses = { ...sharedReviewWriteFailureStatus, ...overrides };
  return statuses[reason];
}

/** The status each failure kind answers with, for every service that has a reason table. */
const failureKindStatuses = {
  invalid: 400,
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  unavailable: 503,
} as const satisfies Record<FailureKind, ResponseFailureStatus>;

export function insightFailureStatus(failure: InsightCoordinatorFailure) {
  return failureKindStatuses[insightFailureKinds[failure]];
}

/** The statuses `response` answers a failed result with. */
type ResponseFailureStatus = 400 | 401 | 403 | 404 | 409 | 503;

/**
 * Every failure reason `response` can put on the wire, and the status it
 * answers with. Enumerated from the thirty `response(...)` call sites and
 * the error types their producers declare. A table rather than the substring
 * ladder it replaces, because that ladder decided several of these by
 * accident — `merge_forbidden` reached 403 by containing "forbidden" — so
 * renaming a reason silently moved its status. Every status below is the one
 * that ladder produced.
 */
const responseFailureStatus = new Map<string, ResponseFailureStatus>([
  ["not_found", 404],
  ["github_auth", 401],
  ["authentication_required", 401],
  ["merge_forbidden", 403],
  // Conflicts with state the client wrote against, or with a write already
  // running. `revision_conflict` is declared by `ReviewWorkbenchFailure` and
  // constructed nowhere; it stays so producing it later keeps this status.
  ["head_changed", 409],
  ["merge_in_progress", 409],
  ["merge_outcome_unknown", 409],
  ["not_fresh", 409],
  ["revision_conflict", 409],
  ["operation_active", 409],
  ["operation_expired", 404],
  // A local Review source: the repository has no checkout in the profile, the named checkout is not one of its worktrees, or git has no such revision.
  ["repository_not_local", 404],
  ["checkout_not_found", 404],
  ["revision_not_found", 404],
  ["unmerged_index", 409],
  // Apply suggestion on a local Review (ADR 0050): refusals the maintainer resolves by reopening or checking.
  ["revision_changed", 409],
  ["not_working_tree", 409],
  ["apply_locked", 409],
  ["in_progress", 409],
  ["not_applicable", 409],
  // A text Change intent holding a credential-shaped value, which Patchdesk never stores.
  ["change_intent_sensitive", 400],
  ["overlapping", 409],
  ["path_refused", 409],
  ["file_changed", 409],
  ["check_failed", 409],
  ["working_tree_conversion", 409],
  ["checkout_unavailable", 503],
  ["stale_head", 409],
  ["terminal", 409],
  // A caller abandoned a provider activation. The request-owning renderer
  // consumes this exact reason without presenting it as a runtime failure.
  ["cancelled", 400],
  ["github_read", 503],
  ["merge_rate_limited", 503],
  ["rate_limited", 503],
  ["runtime_unavailable", 503],
  ["storage", 503],
  ["storage_failed", 503],
  // Reported as a malformed request today, and only `invalid_input` belongs
  // here: `stale` is the conflict its sibling `stale_head` answers with 409,
  // `merge_blocked` and `merge_acknowledgement_required` are refusals,
  // `invalid_result` and `merge_failed` are upstream failures, and
  // `timed_out` never reaches the renderer's 504 branch. Correcting any of
  // them changes what the renderer shows, so each needs its own change.
  ["invalid_input", 400],
  ["invalid_result", 400],
  ["merge_acknowledgement_required", 400],
  ["merge_blocked", 400],
  ["merge_failed", 400],
  ["stale", 400],
  ["timed_out", 400],
]);

/**
 * The default answers a reason no producer declares — `MergeWriteController`
 * types its failure as a bare `string`, so this cannot be a total function.
 */
function statusForReason(reason: string): ResponseFailureStatus {
  return responseFailureStatus.get(reason) ?? 400;
}

export function response(
  context: Context,
  result:
    | { readonly _tag: "ok"; readonly value: unknown }
    | { readonly _tag: "err"; readonly error: { readonly reason: string } },
): Response {
  return result._tag === "ok"
    ? context.json(result.value)
    : context.json(
        { error: result.error.reason },
        statusForReason(result.error.reason),
      );
}

/**
 * A service result on the wire: its value, or `{ error: reason }` with the
 * status `kinds` classifies the reason as. A working-tree branch refusal also
 * names the checkout's branch (null when detached) so the renderer can say
 * which one to switch to.
 */
export function serviceResponse<Reason extends string>(
  context: Context,
  result:
    | { readonly _tag: "ok"; readonly value: unknown }
    | {
        readonly _tag: "err";
        readonly error: {
          readonly reason: Reason;
          readonly currentBranch?: string;
        };
      },
  kinds: FailureKinds<NoInfer<Reason>>,
): Response {
  if (result._tag === "ok") return context.json(result.value);
  const { reason, currentBranch } = result.error;
  const status: ResponseFailureStatus = failureKindStatuses[kinds[reason]];
  return reason === "branch_mismatch"
    ? context.json(
        { error: reason, currentBranch: currentBranch ?? null },
        status,
      )
    : context.json({ error: reason }, status);
}
