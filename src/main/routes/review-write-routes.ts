import type { Context, Hono } from "hono";
import {
  array,
  boolean,
  integer,
  literal,
  minLength,
  number,
  object,
  picklist,
  pipe,
  safeParse,
  strictObject,
  string,
  variant,
} from "valibot";

import {
  parseContentHash,
  parseGitSha,
  parseGitHubThreadId,
  parseReviewId,
  parseReviewSessionId,
  parseWorkspaceProfileId,
  type ReviewId,
  type WorkspaceProfileId,
} from "../../domain/ids";
import type { RawJsonValue } from "../../domain/json";
import { readObjectField } from "../../services/read-object-field";
import type {
  AssigneeCommand,
  AssigneeService,
} from "../../services/assignee-service";
import type {
  DirectConversationCommand,
  InlineConversationService,
} from "../../services/inline-conversation-service";
import type { LabelCommand, LabelService } from "../../services/label-service";
import type {
  ReviewerCommand,
  ReviewerService,
} from "../../services/reviewer-service";
import type { LocalApiContainer, LogWriter } from "../local-api-container";
import {
  assigneeListResponse,
  labelListResponse,
  reviewerListResponse,
} from "./github-listing-response";
import { mapReviewWriteFailureStatus } from "./http-status";
import { jsonBody } from "./json-body";

/** The Review-scoped writes that change a pull request's own metadata and conversation. */
export function registerReviewWriteRoutes(
  app: Hono,
  container: LocalApiContainer,
): void {
  const {
    assigneeWrites,
    inlineConversations,
    labelWrites,
    logs,
    reviewerWrites,
  } = container;
  app.post("/v1/reviews/inline-conversations/command", async (context) =>
    inlineConversationResponse(
      context,
      inlineConversations,
      parseInlineConversationCommand(await jsonBody(context), logs),
    ),
  );
  app.post("/v1/reviews/labels/command", async (context) =>
    labelResponse(context, labelWrites, await jsonBody(context)),
  );
  app.get("/v1/reviews/labels", async (context) => {
    const profileId = parseWorkspaceProfileId(context.req.query("profileId"));
    const reviewId = parseReviewId(context.req.query("reviewId"));
    if (profileId._tag === "err" || reviewId._tag === "err")
      return context.json({ error: "invalid_input" }, 400);
    return labelListResponse(
      context,
      await labelWrites.list({
        profileId: profileId.value,
        reviewId: reviewId.value,
      }),
    );
  });
  app.post("/v1/reviews/assignees/command", async (context) =>
    assigneeResponse(context, assigneeWrites, await jsonBody(context)),
  );
  app.get("/v1/reviews/assignees", async (context) => {
    const profileId = parseWorkspaceProfileId(context.req.query("profileId"));
    const reviewId = parseReviewId(context.req.query("reviewId"));
    if (profileId._tag === "err" || reviewId._tag === "err")
      return context.json({ error: "invalid_input" }, 400);
    const rawQuery = context.req.query("query");
    const queryField =
      rawQuery !== undefined && rawQuery.length > 0 ? { query: rawQuery } : {};
    return assigneeListResponse(
      context,
      await assigneeWrites.list({
        profileId: profileId.value,
        reviewId: reviewId.value,
        ...queryField,
      }),
    );
  });
  app.post("/v1/reviews/reviewers/command", async (context) =>
    reviewerResponse(context, reviewerWrites, await jsonBody(context)),
  );
  app.get("/v1/reviews/reviewers", async (context) => {
    const profileId = parseWorkspaceProfileId(context.req.query("profileId"));
    const reviewId = parseReviewId(context.req.query("reviewId"));
    if (profileId._tag === "err" || reviewId._tag === "err")
      return context.json({ error: "invalid_input" }, 400);
    const rawQuery = context.req.query("query");
    const queryField =
      rawQuery !== undefined && rawQuery.length > 0 ? { query: rawQuery } : {};
    return reviewerListResponse(
      context,
      await reviewerWrites.list({
        profileId: profileId.value,
        reviewId: reviewId.value,
        ...queryField,
      }),
    );
  });
}

const labelRefSchema = strictObject({
  id: pipe(string(), minLength(1)),
  name: pipe(string(), minLength(1)),
});
const labelCommandSchema = strictObject({
  profileId: pipe(string(), minLength(1)),
  reviewId: pipe(string(), minLength(1)),
  command: variant("_tag", [
    strictObject({
      _tag: picklist(["AddLabels"] as const),
      labels: pipe(array(labelRefSchema), minLength(1)),
    }),
    strictObject({
      _tag: picklist(["RemoveLabels"] as const),
      labels: pipe(array(labelRefSchema), minLength(1)),
    }),
  ]),
});
const assigneeRefSchema = strictObject({
  id: pipe(string(), minLength(1)),
  login: pipe(string(), minLength(1)),
});
const assigneeCommandSchema = strictObject({
  profileId: pipe(string(), minLength(1)),
  reviewId: pipe(string(), minLength(1)),
  command: variant("_tag", [
    strictObject({
      _tag: picklist(["AddAssignees"] as const),
      assignees: pipe(array(assigneeRefSchema), minLength(1)),
    }),
    strictObject({
      _tag: picklist(["RemoveAssignees"] as const),
      assignees: pipe(array(assigneeRefSchema), minLength(1)),
    }),
    strictObject({
      _tag: picklist(["AssignSelf"] as const),
    }),
  ]),
});
const reviewerRefSchema = strictObject({
  id: pipe(string(), minLength(1)),
  login: pipe(string(), minLength(1)),
});
const reviewerCommandSchema = strictObject({
  profileId: pipe(string(), minLength(1)),
  reviewId: pipe(string(), minLength(1)),
  command: variant("_tag", [
    strictObject({
      _tag: picklist(["RequestReviewers"] as const),
      reviewers: pipe(array(reviewerRefSchema), minLength(1)),
    }),
    strictObject({
      _tag: picklist(["RemoveReviewers"] as const),
      reviewers: pipe(array(reviewerRefSchema), minLength(1)),
    }),
  ]),
});

async function inlineConversationResponse(
  context: Context,
  service: InlineConversationService,
  parsed: ParsedInlineConversationCommand | undefined,
): Promise<Response> {
  if (parsed === undefined)
    return context.json({ error: "invalid_input" }, 400);
  const result = await service.execute(parsed);
  if (result._tag === "ok") return context.json(result.value);
  return context.json(
    { error: result.error },
    // The three conversation-only reasons are all conflicts with the state
    // the client wrote against.
    mapReviewWriteFailureStatus(result.error, {
      not_fresh: 409,
      pending_review: 409,
      confirmation_required: 409,
    }),
  );
}
type ParsedInlineConversationCommand = {
  readonly profileId: WorkspaceProfileId;
  readonly reviewId: ReviewId;
  readonly command: DirectConversationCommand;
};
function parseInlineConversationCommand(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- this function is the route's I/O boundary parser; it runs its own schema/field parsing on the raw body immediately.
  body: unknown,
  logs: LogWriter,
): ParsedInlineConversationCommand | undefined {
  const profileId = parseWorkspaceProfileId(readObjectField(body, "profileId"));
  const reviewId = parseReviewId(readObjectField(body, "reviewId"));
  const raw = readObjectField(body, "command");
  const tag = readObjectField(raw, "_tag");
  const expectedRaw = readObjectField(raw, "expected");
  const sessionId = parseReviewSessionId(
    readObjectField(expectedRaw, "sessionId"),
  );
  const headSha = parseGitSha(readObjectField(expectedRaw, "headSha"));
  const patchHash = parseContentHash(readObjectField(expectedRaw, "patchHash"));
  const profileOk = profileId._tag;
  const reviewOk = reviewId._tag;
  const sessionOk = sessionId._tag;
  const headShaOk = headSha._tag;
  const patchHashOk = patchHash._tag;
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- narrows a raw JSON field (from readObjectField, typed unknown) at this exact I/O boundary; no earlier parser exists for this primitive shape.
  const tagType = typeof tag;
  if (
    profileOk === "err" ||
    reviewOk === "err" ||
    sessionOk === "err" ||
    headShaOk === "err" ||
    patchHashOk === "err" ||
    tagType !== "string"
  ) {
    logs.write({
      process: "main",
      level: "warn",
      topic: "http",
      message: "inline conversation command parse failed",
      meta: { profileOk, reviewOk, sessionOk, headShaOk, patchHashOk, tagType },
    });
    return undefined;
  }
  const expected = {
    sessionId: sessionId.value,
    headSha: headSha.value,
    patchHash: patchHash.value,
  };
  const parsed = safeParse(inlineConversationCommandSchema, raw);
  if (!parsed.success) return undefined;
  const command = parsed.output;
  // The one rule left that no schema can state: a thread identifier has to be
  // one GitHub can address.
  if (
    (command._tag === "Reply" || command._tag === "SetThreadState") &&
    parseGitHubThreadId(command.threadId)._tag === "err"
  )
    return undefined;
  return {
    profileId: profileId.value,
    reviewId: reviewId.value,
    command: { ...command, expected },
  };
}

/**
 * Looser than `pendingReviewAnchorSchema`: this route places a comment
 * against whatever line pair the client read off the diff, without the
 * pending review's `startLine >= 1` and `line >= startLine` rules, and keeps
 * the plain-string path `DirectConversationCommand` declares.
 */
const inlineConversationAnchorSchema = object({
  path: string(),
  startLine: pipe(number(), integer()),
  line: pipe(number(), integer()),
  side: picklist(["new", "old"]),
});

/**
 * `expected` is absent from every member on purpose: the caller reads and
 * brands it first, so it can report which field failed before this runs.
 */
const inlineConversationCommandSchema = variant("_tag", [
  object({
    _tag: literal("CreateComment"),
    anchor: inlineConversationAnchorSchema,
    body: string(),
  }),
  object({ _tag: literal("Reply"), threadId: string(), body: string() }),
  object({
    _tag: literal("SetThreadState"),
    threadId: string(),
    state: picklist(["open", "resolved"]),
  }),
  object({ _tag: literal("EditComment"), commentId: string(), body: string() }),
  object({
    _tag: literal("DeleteComment"),
    commentId: string(),
    // Any boolean, not only `true`: unlike a pending-review discard, this
    // route answers an unconfirmed delete with `confirmation_required`
    // rather than refusing the command as malformed.
    confirmation: boolean(),
  }),
]);

async function labelResponse(
  context: Context,
  service: LabelService,
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- this function is the route's I/O boundary parser; it runs its own schema/field parsing on the raw body immediately.
  body: unknown,
): Promise<Response> {
  const parsed = safeParse(labelCommandSchema, body);
  if (!parsed.success) return context.json({ error: "invalid_input" }, 400);
  const profileId = parseWorkspaceProfileId(parsed.output.profileId);
  const reviewId = parseReviewId(parsed.output.reviewId);
  if (profileId._tag === "err" || reviewId._tag === "err")
    return context.json({ error: "invalid_input" }, 400);
  const command: LabelCommand = parsed.output.command;
  const result = await service.execute({
    profileId: profileId.value,
    reviewId: reviewId.value,
    command,
  });
  if (result._tag === "ok") return context.json(result.value);
  // `LabelWriteFailure` is exactly the shared eight, so no overrides.
  return context.json(
    { error: result.error },
    mapReviewWriteFailureStatus(result.error, {}),
  );
}

async function assigneeResponse(
  context: Context,
  service: AssigneeService,
  body: RawJsonValue | undefined,
): Promise<Response> {
  const parsed = safeParse(assigneeCommandSchema, body);
  if (!parsed.success) return context.json({ error: "invalid_input" }, 400);
  const profileId = parseWorkspaceProfileId(parsed.output.profileId);
  const reviewId = parseReviewId(parsed.output.reviewId);
  if (profileId._tag === "err" || reviewId._tag === "err")
    return context.json({ error: "invalid_input" }, 400);
  const command: AssigneeCommand = parsed.output.command;
  const result = await service.execute({
    profileId: profileId.value,
    reviewId: reviewId.value,
    command,
  });
  if (result._tag === "ok") return context.json(result.value);
  return context.json(
    { error: result.error },
    // "assignee_cap_exceeded" joins "invalid_input" at 400: another rule the
    // service enforces locally, not a GitHub-reported conflict.
    mapReviewWriteFailureStatus(result.error, { assignee_cap_exceeded: 400 }),
  );
}

async function reviewerResponse(
  context: Context,
  service: ReviewerService,
  body: RawJsonValue | undefined,
): Promise<Response> {
  const parsed = safeParse(reviewerCommandSchema, body);
  if (!parsed.success) return context.json({ error: "invalid_input" }, 400);
  const profileId = parseWorkspaceProfileId(parsed.output.profileId);
  const reviewId = parseReviewId(parsed.output.reviewId);
  if (profileId._tag === "err" || reviewId._tag === "err")
    return context.json({ error: "invalid_input" }, 400);
  const command: ReviewerCommand = parsed.output.command;
  const result = await service.execute({
    profileId: profileId.value,
    reviewId: reviewId.value,
    command,
  });
  if (result._tag === "ok") return context.json(result.value);
  // `ReviewerWriteFailure` is exactly the shared eight: no reviewer cap
  // exists to enforce, so unlike assignees there is nothing to override.
  return context.json(
    { error: result.error },
    mapReviewWriteFailureStatus(result.error, {}),
  );
}
