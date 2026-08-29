import {
  check,
  literal,
  object,
  optional,
  picklist,
  pipe,
  safeParse,
  string,
  variant,
  type InferOutput,
} from "valibot";

import { definedProps } from "../../domain/defined-props";
import {
  anchorSchema,
  findingSourceSchema,
  parseFindingReviewSourceFields,
  parsePendingReviewAnchorFields,
  type FindingReviewSource,
  type PendingReviewAnchor,
} from "../../domain/pending-review";
import {
  parseContentHash,
  parseGitSha,
  parseGitHubReviewNodeId,
  parseReviewId,
  parseReviewSessionId,
  parseWorkspaceProfileId,
  type GitHubReviewNodeId,
  type ReviewId,
  type WorkspaceProfileId,
} from "../../domain/ids";
import type { ReviewWriteExpectation } from "../../services/review-write-gate";

type PendingReviewCommandDto =
  | {
      readonly _tag: "Start";
      readonly expected: ReviewWriteExpectation;
      readonly anchor: PendingReviewAnchor;
      readonly body: string;
      readonly finding?: FindingReviewSource;
    }
  | {
      readonly _tag: "AddThread";
      readonly expected: ReviewWriteExpectation;
      readonly pendingReviewNodeId: GitHubReviewNodeId;
      readonly anchor: PendingReviewAnchor;
      readonly body: string;
      readonly finding?: FindingReviewSource;
    }
  | {
      readonly _tag: "Submit";
      readonly expected: ReviewWriteExpectation;
      readonly event: "APPROVE" | "COMMENT" | "REQUEST_CHANGES";
      readonly summaryBody: string;
    }
  | {
      readonly _tag: "Discard";
      readonly expected: ReviewWriteExpectation;
      readonly confirmation: true;
    };

const reviewWriteExpectationSchema = object({
  sessionId: string(),
  headSha: string(),
  patchHash: string(),
});

/**
 * The wire shapes of the two pending-review payloads that also live in a
 * durable artifact. Both take their fields from the domain's own schemas so
 * route and stored record cannot drift apart, and both relax `strictObject`
 * to `object`: a request body may carry keys this route does not read, which
 * the field-by-field reads they replaced ignored.
 */
const pendingReviewAnchorSchema = object(anchorSchema.entries);
const findingReviewSourceSchema = object(findingSourceSchema.entries);

const reviewEventSchema = picklist(["APPROVE", "COMMENT", "REQUEST_CHANGES"]);

/**
 * A comment body has to hold something other than whitespace. The trim is
 * only the test — the body is stored exactly as the client sent it.
 */
const commentBodySchema = pipe(
  string(),
  check((value) => value.trim().length > 0),
);

const directSummaryCommandSchema = object({
  profileId: string(),
  reviewId: string(),
  expected: reviewWriteExpectationSchema,
  event: reviewEventSchema,
  body: commentBodySchema,
});

const pendingReviewCommandSchema = object({
  profileId: string(),
  reviewId: string(),
  command: variant("_tag", [
    object({
      _tag: literal("Start"),
      expected: reviewWriteExpectationSchema,
      anchor: pendingReviewAnchorSchema,
      body: commentBodySchema,
      finding: optional(findingReviewSourceSchema),
    }),
    object({
      _tag: literal("AddThread"),
      expected: reviewWriteExpectationSchema,
      pendingReviewNodeId: string(),
      anchor: pendingReviewAnchorSchema,
      body: commentBodySchema,
      finding: optional(findingReviewSourceSchema),
    }),
    object({
      _tag: literal("Submit"),
      expected: reviewWriteExpectationSchema,
      event: reviewEventSchema,
      // No emptiness rule, unlike a comment body: a review verdict may be
      // submitted with no summary at all.
      summaryBody: string(),
    }),
    object({
      _tag: literal("Discard"),
      expected: reviewWriteExpectationSchema,
      // Discard is destructive: the command must carry the explicit
      // confirmation, so `false` is as invalid as an absent field.
      confirmation: literal(true),
    }),
  ]),
});

export function parseDirectSummaryCommand(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- this function is the route's I/O boundary parser; it runs its own schema parsing on the raw body immediately.
  body: unknown,
):
  | {
      readonly profileId: WorkspaceProfileId;
      readonly reviewId: ReviewId;
      readonly expected: ReviewWriteExpectation;
      readonly event: "APPROVE" | "COMMENT" | "REQUEST_CHANGES";
      readonly body: string;
    }
  | undefined {
  const parsed = safeParse(directSummaryCommandSchema, body);
  if (!parsed.success) return undefined;
  const profileId = parseWorkspaceProfileId(parsed.output.profileId);
  const reviewId = parseReviewId(parsed.output.reviewId);
  const expected = parseReviewWriteExpectation(parsed.output.expected);
  return profileId._tag === "err" ||
    reviewId._tag === "err" ||
    expected === undefined
    ? undefined
    : {
        profileId: profileId.value,
        reviewId: reviewId.value,
        expected,
        event: parsed.output.event,
        body: parsed.output.body,
      };
}

export function parsePendingReviewCommand(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- this function is the route's I/O boundary parser; it runs its own schema parsing on the raw body immediately.
  body: unknown,
):
  | {
      readonly profileId: WorkspaceProfileId;
      readonly reviewId: ReviewId;
      readonly command: PendingReviewCommandDto;
    }
  | undefined {
  const parsed = safeParse(pendingReviewCommandSchema, body);
  if (!parsed.success) return undefined;
  const profileId = parseWorkspaceProfileId(parsed.output.profileId);
  const reviewId = parseReviewId(parsed.output.reviewId);
  const expected = parseReviewWriteExpectation(parsed.output.command.expected);
  if (
    profileId._tag === "err" ||
    reviewId._tag === "err" ||
    expected === undefined
  )
    return undefined;
  const command = parsePendingReviewCommandDto(parsed.output.command, expected);
  return command === undefined
    ? undefined
    : { profileId: profileId.value, reviewId: reviewId.value, command };
}

/**
 * Turns one shape-checked pending-review command into its DTO, applying the
 * identifier rules the schema cannot express. `Submit` and `Discard` carry
 * none; the two thread-writing commands share an anchor and an optional
 * Finding authorization, so they share this parse.
 */
function parsePendingReviewCommandDto(
  command: InferOutput<typeof pendingReviewCommandSchema>["command"],
  expected: ReviewWriteExpectation,
): PendingReviewCommandDto | undefined {
  if (command._tag === "Submit")
    return {
      _tag: "Submit",
      expected,
      event: command.event,
      summaryBody: command.summaryBody,
    };
  if (command._tag === "Discard")
    return { _tag: "Discard", expected, confirmation: true };
  const anchor = parsePendingReviewAnchorFields(command.anchor);
  const finding =
    command.finding === undefined
      ? undefined
      : parseFindingReviewSourceFields(command.finding);
  if (
    anchor === undefined ||
    (command.finding !== undefined && finding === undefined)
  )
    return undefined;
  const authorization = definedProps({ finding });
  if (command._tag === "Start")
    return {
      _tag: "Start",
      expected,
      anchor,
      body: command.body,
      ...authorization,
    };
  const nodeId = parseGitHubReviewNodeId(command.pendingReviewNodeId);
  return nodeId._tag === "err"
    ? undefined
    : {
        _tag: "AddThread",
        expected,
        pendingReviewNodeId: nodeId.value,
        anchor,
        body: command.body,
        ...authorization,
      };
}

function parseReviewWriteExpectation(
  input: InferOutput<typeof reviewWriteExpectationSchema>,
): ReviewWriteExpectation | undefined {
  const sessionId = parseReviewSessionId(input.sessionId);
  const headSha = parseGitSha(input.headSha);
  const patchHash = parseContentHash(input.patchHash);
  return sessionId._tag === "err" ||
    headSha._tag === "err" ||
    patchHash._tag === "err"
    ? undefined
    : {
        sessionId: sessionId.value,
        headSha: headSha.value,
        patchHash: patchHash.value,
      };
}
