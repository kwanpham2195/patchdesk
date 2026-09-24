import type { Context, Hono } from "hono";
import {
  array,
  boolean,
  integer,
  literal,
  minLength,
  number,
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
import type {
  AssigneeCommand,
  AssigneeService,
} from "../../services/assignee-service";
import type {
  DirectConversationCommand,
  InlineConversationService,
} from "../../services/inline-conversation-service";
import type { LabelCommand, LabelService } from "../../services/label-service";
import type { ReviewWriteRecoveryFailure } from "../../services/review-write-recovery-service";
import type {
  BaseBranchCommand,
  BaseBranchService,
} from "../../services/base-branch-service";
import type {
  DraftStateCommand,
  DraftStateService,
} from "../../services/draft-state-service";
import type {
  ReviewerCommand,
  ReviewerService,
} from "../../services/reviewer-service";
import type { LocalApiContainer, LogWriter } from "../local-api-container";
import {
  assigneeListResponse,
  baseBranchListResponse,
  labelListResponse,
  reviewerListResponse,
} from "./github-listing-response";
import { mapReviewWriteFailureStatus, response } from "./http-status";
import { jsonBody } from "./json-body";
import { reviewRecoverySchema } from "./review-recovery-schema";

/** The Review-scoped writes that change a pull request's own metadata and conversation. */
export function registerReviewWriteRoutes(
  app: Hono,
  container: LocalApiContainer,
): void {
  const {
    assigneeWrites,
    baseBranchWrites,
    draftStateWrites,
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
  app.post("/v1/reviews/write/recover", async (context) => {
    const parsed = safeParse(reviewRecoverySchema, await jsonBody(context));
    if (!parsed.success) return context.json({ error: "invalid_input" }, 400);
    const profileId = parseWorkspaceProfileId(parsed.output.profileId);
    const reviewId = parseReviewId(parsed.output.reviewId);
    if (profileId._tag === "err" || reviewId._tag === "err")
      return context.json({ error: "invalid_input" }, 400);
    const input = { profileId: profileId.value, reviewId: reviewId.value };
    const recovered = await container.reviewWriteRecovery.recover(input);
    if (recovered._tag === "err")
      return context.json(
        { error: recovered.error },
        reviewWriteRecoveryFailureStatus(recovered.error),
      );
    if (
      recovered.value._tag === "Confirmed" ||
      recovered.value._tag === "NoOperation"
    ) {
      const receipt =
        recovered.value._tag === "Confirmed"
          ? recovered.value.receipt
          : undefined;
      // The renderer can raise an ephemeral lock after a confirmed refresh
      // failure, so NoOperation still needs a read before that lock may clear.
      const detected = await container.reviewWorkbench.detectUpdates(
        receipt === undefined ? input : { ...input, recentWrites: [receipt] },
      );
      if (detected._tag === "err") return response(context, detected);
    }
    return response(
      context,
      await container.reviewWorkbench.load(parsed.output),
    );
  });
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
  app.post("/v1/reviews/draft-state/command", async (context) =>
    draftStateResponse(context, draftStateWrites, await jsonBody(context)),
  );
  app.post("/v1/reviews/base-branch/command", async (context) =>
    baseBranchResponse(context, baseBranchWrites, await jsonBody(context)),
  );
  app.get("/v1/reviews/base-branch", async (context) => {
    const profileId = parseWorkspaceProfileId(context.req.query("profileId"));
    const reviewId = parseReviewId(context.req.query("reviewId"));
    if (profileId._tag === "err" || reviewId._tag === "err")
      return context.json({ error: "invalid_input" }, 400);
    const rawQuery = context.req.query("query");
    const queryField =
      rawQuery !== undefined && rawQuery.length > 0 ? { query: rawQuery } : {};
    return baseBranchListResponse(
      context,
      await baseBranchWrites.list({
        profileId: profileId.value,
        reviewId: reviewId.value,
        ...queryField,
      }),
    );
  });
}

function reviewWriteRecoveryFailureStatus(
  failure: ReviewWriteRecoveryFailure,
): 404 | 409 | 503 {
  if (failure === "not_found") return 404;
  if (failure === "not_fresh" || failure === "review_write_in_progress")
    return 409;
  return 503;
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
const draftStateCommandSchema = strictObject({
  profileId: pipe(string(), minLength(1)),
  reviewId: pipe(string(), minLength(1)),
  command: strictObject({
    _tag: picklist(["SetDraftState"] as const),
    draft: boolean(),
  }),
});

const baseBranchCommandSchema = strictObject({
  profileId: pipe(string(), minLength(1)),
  reviewId: pipe(string(), minLength(1)),
  command: strictObject({
    _tag: picklist(["SetBaseBranch"] as const),
    branch: pipe(string(), minLength(1)),
  }),
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
      outcome_unknown: 409,
    }),
  );
}
type ParsedInlineConversationCommand = {
  readonly profileId: WorkspaceProfileId;
  readonly reviewId: ReviewId;
  readonly command: DirectConversationCommand;
};
function parseInlineConversationCommand(
  body: RawJsonValue | undefined,
  logs: LogWriter,
): ParsedInlineConversationCommand | undefined {
  const parsed = safeParse(inlineConversationBodySchema, body);
  if (!parsed.success) {
    warnInlineConversationParseFailed(logs, { schemaOk: "err" });
    return undefined;
  }
  const { command } = parsed.output;
  const profileId = parseWorkspaceProfileId(parsed.output.profileId);
  const reviewId = parseReviewId(parsed.output.reviewId);
  const sessionId = parseReviewSessionId(command.expected.sessionId);
  const headSha = parseGitSha(command.expected.headSha);
  const patchHash = parseContentHash(command.expected.patchHash);
  if (
    profileId._tag === "err" ||
    reviewId._tag === "err" ||
    sessionId._tag === "err" ||
    headSha._tag === "err" ||
    patchHash._tag === "err"
  ) {
    warnInlineConversationParseFailed(logs, {
      schemaOk: "ok",
      profileOk: profileId._tag,
      reviewOk: reviewId._tag,
      sessionOk: sessionId._tag,
      headShaOk: headSha._tag,
      patchHashOk: patchHash._tag,
    });
    return undefined;
  }
  const expected = {
    sessionId: sessionId.value,
    headSha: headSha.value,
    patchHash: patchHash.value,
  };
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

/** Reports which parse stage failed by outcome only, so no body value reaches the log. */
function warnInlineConversationParseFailed(
  logs: LogWriter,
  outcomes: Readonly<Record<string, "ok" | "err">>,
): void {
  logs.write({
    process: "main",
    level: "warn",
    topic: "http",
    message: "inline conversation command parse failed",
    meta: outcomes,
  });
}

/**
 * Looser than `pendingReviewAnchorSchema`: this route places a comment
 * against whatever line pair the client read off the diff, without the
 * pending review's `startLine >= 1` and `line >= startLine` rules, and keeps
 * the plain-string path `DirectConversationCommand` declares.
 */
const inlineConversationAnchorSchema = strictObject({
  path: string(),
  startLine: pipe(number(), integer()),
  line: pipe(number(), integer()),
  side: picklist(["new", "old"]),
});

const inlineConversationExpectedSchema = strictObject({
  sessionId: string(),
  headSha: string(),
  patchHash: string(),
});

const inlineConversationCommandSchema = variant("_tag", [
  strictObject({
    _tag: literal("CreateComment"),
    expected: inlineConversationExpectedSchema,
    anchor: inlineConversationAnchorSchema,
    body: string(),
  }),
  strictObject({
    _tag: literal("Reply"),
    expected: inlineConversationExpectedSchema,
    threadId: string(),
    body: string(),
  }),
  strictObject({
    _tag: literal("SetThreadState"),
    expected: inlineConversationExpectedSchema,
    threadId: string(),
    state: picklist(["open", "resolved"]),
  }),
  strictObject({
    _tag: literal("EditComment"),
    expected: inlineConversationExpectedSchema,
    commentId: string(),
    body: string(),
  }),
  strictObject({
    _tag: literal("DeleteComment"),
    expected: inlineConversationExpectedSchema,
    commentId: string(),
    // Any boolean, not only `true`: unlike a pending-review discard, this
    // route answers an unconfirmed delete with `confirmation_required`
    // rather than refusing the command as malformed.
    confirmation: boolean(),
  }),
]);

const inlineConversationBodySchema = strictObject({
  profileId: pipe(string(), minLength(1)),
  reviewId: pipe(string(), minLength(1)),
  command: inlineConversationCommandSchema,
});

async function labelResponse(
  context: Context,
  service: LabelService,
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

async function draftStateResponse(
  context: Context,
  service: DraftStateService,
  body: RawJsonValue | undefined,
): Promise<Response> {
  const parsed = safeParse(draftStateCommandSchema, body);
  if (!parsed.success) return context.json({ error: "invalid_input" }, 400);
  const profileId = parseWorkspaceProfileId(parsed.output.profileId);
  const reviewId = parseReviewId(parsed.output.reviewId);
  if (profileId._tag === "err" || reviewId._tag === "err")
    return context.json({ error: "invalid_input" }, 400);
  const command: DraftStateCommand = parsed.output.command;
  const result = await service.execute({
    profileId: profileId.value,
    reviewId: reviewId.value,
    command,
  });
  if (result._tag === "ok") return context.json(result.value);
  // `DraftStateWriteFailure` is exactly the shared eight; the no-op refusal
  // reuses `invalid_input`, which already answers 400.
  return context.json(
    { error: result.error },
    mapReviewWriteFailureStatus(result.error, {}),
  );
}

async function baseBranchResponse(
  context: Context,
  service: BaseBranchService,
  body: RawJsonValue | undefined,
): Promise<Response> {
  const parsed = safeParse(baseBranchCommandSchema, body);
  if (!parsed.success) return context.json({ error: "invalid_input" }, 400);
  const profileId = parseWorkspaceProfileId(parsed.output.profileId);
  const reviewId = parseReviewId(parsed.output.reviewId);
  if (profileId._tag === "err" || reviewId._tag === "err")
    return context.json({ error: "invalid_input" }, 400);
  const command: BaseBranchCommand = parsed.output.command;
  const result = await service.execute({
    profileId: profileId.value,
    reviewId: reviewId.value,
    command,
  });
  if (result._tag === "ok") return context.json(result.value);
  return context.json(
    { error: result.error },
    mapReviewWriteFailureStatus(result.error, {}),
  );
}
