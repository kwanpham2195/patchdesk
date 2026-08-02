import { readFile } from "node:fs/promises";
import * as v from "valibot";

import type { ReviewSessionStore } from "../adapters/storage/review-session-store";
import type { ReviewStore } from "../adapters/storage/review-store";
import type { InsightStore } from "../adapters/storage/insight-store";
import {
  parseGitHubThreadId,
  parseGitSha,
  parseContentHash,
  parseIsoTimestamp,
  parseFindingId,
  parseInsightRunId,
  parseLocalReviewItemId,
  parseReviewId,
  parseRepoRelativePath,
  parseReviewSessionId,
  parseWorkspaceProfileId,
  type ContentHash,
  type FindingId,
  type GitSha,
  type InsightRunId,
  type ReviewId,
  type ReviewSessionId,
  type WorkspaceProfileId,
  type GitHubThreadId,
  type IsoTimestamp,
  type LocalReviewItemId,
} from "../domain/ids";
import {
  parseReviewBatch,
  type ReviewAnchorFingerprint,
  type ReviewAnchor,
  type ReviewBatch,
  type ReviewBatchItem,
  type GitHubReviewEvent,
} from "../domain/review-batch";
import {
  discardBatchForRerun,
  type ReviewSession,
} from "../domain/review-session";
import { fingerprintPatchAnchor } from "../domain/review-anchor";
import { parseReviewResult, type ReviewResult } from "../domain/review-result";
import { readObjectField } from "./read-object-field";
import { contentHash } from "./review-artifact-hash";
import { err, ok, type Result } from "../domain/result";
import { withReviewSessionMutationLock } from "./review-session-mutation-lock";

const anchorSchema = v.strictObject({
  path: v.string(),
  startLine: v.pipe(v.number(), v.integer(), v.minValue(1)),
  line: v.pipe(v.number(), v.integer(), v.minValue(1)),
  side: v.picklist(["new", "old"]),
});

const fingerprintSchema = v.strictObject({
  path: v.string(),
  side: v.picklist(["new", "old"]),
  startLine: v.pipe(v.number(), v.integer(), v.minValue(1)),
  line: v.pipe(v.number(), v.integer(), v.minValue(1)),
  selectedLines: v.pipe(v.array(v.string()), v.maxLength(8)),
  before: v.pipe(v.array(v.string()), v.maxLength(2)),
  after: v.pipe(v.array(v.string()), v.maxLength(2)),
});

const commandSchema = v.variant("_tag", [
  v.strictObject({
    _tag: v.literal("AddInlineComment"),
    anchor: anchorSchema,
    fingerprint: v.optional(fingerprintSchema),
    body: v.string(),
  }),
  v.strictObject({
    _tag: v.literal("AddFindingInlineComment"),
    reviewId: v.string(),
    findingId: v.string(),
    runId: v.string(),
    anchor: anchorSchema,
    fingerprint: fingerprintSchema,
    body: v.string(),
  }),
  v.strictObject({
    _tag: v.literal("AddFindingGeneralComment"),
    reviewId: v.string(),
    findingId: v.string(),
    runId: v.string(),
    body: v.string(),
  }),
  v.strictObject({ _tag: v.literal("UpdateBody"), body: v.string() }),
  v.strictObject({ _tag: v.literal("SetSuggestedEvent"), event: v.picklist(["APPROVE", "COMMENT", "REQUEST_CHANGES"]) }),
  v.strictObject({ _tag: v.literal("SetItemIncluded"), itemId: v.string(), include: v.boolean() }),
  v.strictObject({ _tag: v.literal("RepairInlineAnchor"), itemId: v.string(), anchor: anchorSchema, fingerprint: fingerprintSchema }),
  v.strictObject({
    _tag: v.literal("EditItem"),
    itemId: v.string(),
    body: v.string(),
  }),
  v.strictObject({
    _tag: v.literal("AddGeneralComment"),
    body: v.string(),
  }),
  v.strictObject({
    _tag: v.literal("ConvertInlineToGeneral"),
    itemId: v.string(),
  }),
  v.strictObject({
    _tag: v.literal("RemoveItem"),
    itemId: v.string(),
  }),
  v.strictObject({
    _tag: v.literal("AddThreadReply"),
    threadId: v.string(),
    body: v.string(),
  }),
  v.strictObject({
    _tag: v.literal("SetThreadState"),
    threadId: v.string(),
    action: v.picklist(["resolve", "reopen"]),
  }),
  v.strictObject({
    _tag: v.literal("DiscardForRerun"),
    acknowledgement: v.boolean(),
  }),
]);

const updateSchema = v.strictObject({
  profileId: v.string(),
  sessionId: v.string(),
  expectedRevision: v.string(),
  command: commandSchema,
});

/** One parsed local review-batch edit. */
export type ReviewBatchUpdate =
  | {
      readonly _tag: "AddInlineComment";
      readonly anchor: ReviewAnchor;
      readonly fingerprint?: ReviewAnchorFingerprint;
      readonly body: string;
    }
  | {
      readonly _tag: "AddFindingInlineComment";
      readonly reviewId: ReviewId;
      readonly findingId: FindingId;
      readonly runId: InsightRunId;
      readonly anchor: ReviewAnchor;
      readonly fingerprint: ReviewAnchorFingerprint;
      readonly body: string;
    }
  | {
      readonly _tag: "AddFindingGeneralComment";
      readonly reviewId: ReviewId;
      readonly findingId: FindingId;
      readonly runId: InsightRunId;
      readonly body: string;
    }
  | {
      readonly _tag: "UpdateBody";
      readonly body: string;
    }
  | {
      readonly _tag: "SetSuggestedEvent";
      readonly event: GitHubReviewEvent;
    }
  | {
      readonly _tag: "SetItemIncluded";
      readonly itemId: LocalReviewItemId;
      readonly include: boolean;
    }
  | {
      readonly _tag: "RepairInlineAnchor";
      readonly itemId: LocalReviewItemId;
      readonly anchor: ReviewAnchor;
      readonly fingerprint: ReviewAnchorFingerprint;
    }
  | {
      readonly _tag: "EditItem";
      readonly itemId: LocalReviewItemId;
      readonly body: string;
    }
  | {
      readonly _tag: "AddGeneralComment";
      readonly body: string;
    }
  | {
      readonly _tag: "ConvertInlineToGeneral";
      readonly itemId: LocalReviewItemId;
    }
  | {
      readonly _tag: "RemoveItem";
      readonly itemId: LocalReviewItemId;
    }
  | {
      readonly _tag: "AddThreadReply";
      readonly threadId: GitHubThreadId;
      readonly body: string;
    }
  | {
      readonly _tag: "SetThreadState";
      readonly threadId: GitHubThreadId;
      readonly action: "resolve" | "reopen";
    }
  | {
      readonly _tag: "DiscardForRerun";
      readonly acknowledgement: true;
    };

type FindingCommand = Extract<ReviewBatchUpdate, { readonly _tag: "AddFindingInlineComment" | "AddFindingGeneralComment" }>;

function isFindingCommand(command: ReviewBatchUpdate): command is FindingCommand {
  return command._tag === "AddFindingInlineComment" || command._tag === "AddFindingGeneralComment";
}

type ParsedUpdate = {
  readonly profileId: ReviewSession["key"]["profileId"];
  readonly sessionId: ReviewSession["id"];
  readonly expectedRevision: IsoTimestamp;
  readonly command: ReviewBatchUpdate;
};

/** The exact canonical session and batch after one successful update. */
export type ReviewBatchControllerUpdate = {
  readonly session: ReviewSession;
  readonly batch: ReviewBatch | undefined;
  /** The persisted revision to use for the next compare-and-set command. */
  readonly revision: IsoTimestamp;
};

/** A typed local batch edit rejection. */
export type ReviewBatchControllerFailure = {
  readonly reason:
    | "invalid_input"
    | "acknowledgement_required"
    | "session_not_found"
    | "batch_not_found"
    | "batch_not_editable"
    | "batch_attempt_mismatch"
    | "revision_conflict"
    | "item_not_found"
    | "duplicate_thread_action"
    | "remediation_required"
    | "storage_failed";
};

/**
 * Owns serialized compare-and-set edits to one durable local review batch.
 *
 * Every command is parsed before acquiring the per-session lock. The durable
 * batch remains authoritative for identity, lifecycle, anchors, and receipts.
 */
export class ReviewBatchController {
  constructor(
    private readonly sessions: ReviewSessionStore,
    private readonly now: () => IsoTimestamp,
    private readonly authority?: {
      readonly reviews: Pick<ReviewStore, "load">;
      readonly insights: Pick<InsightStore, "loadTyped">;
    },
  ) {}

  /** Parse and apply one local batch command. */
  async update(
    input: unknown,
  ): Promise<
    Result<ReviewBatchControllerUpdate, ReviewBatchControllerFailure>
  > {
    const parsed = parseUpdate(input);
    if (parsed._tag === "err") {
      return parsed;
    }
    const key = `${parsed.value.profileId}:${parsed.value.sessionId}`;
    return withReviewSessionMutationLock(key, () => this.updateExclusive(parsed.value));
  }

  private async updateExclusive(
    input: ParsedUpdate,
  ): Promise<
    Result<ReviewBatchControllerUpdate, ReviewBatchControllerFailure>
  > {
    const loaded = await this.sessions.load(input.profileId, input.sessionId);
    if (loaded._tag === "err") {
      return err({
        reason:
          loaded.error.reason === "not_found"
            ? "session_not_found"
            : "storage_failed",
      });
    }

    const durable = loaded.value.batchContent;
    if (durable === undefined) {
      return err({ reason: "batch_not_found" });
    }
    if (
      durable.sessionId !== loaded.value.id ||
      durable.attemptId !== undefined
    ) {
      return err({ reason: "batch_attempt_mismatch" });
    }
    if (durable.updatedAt !== input.expectedRevision) {
      return err({ reason: "revision_conflict" });
    }

    const revision = nextRevision(durable.updatedAt, this.now());
    if (input.command._tag === "DiscardForRerun") {
      const discarded = discardBatchForRerun(loaded.value, revision);
      if (discarded._tag === "err") {
        return err({ reason: "remediation_required" });
      }
      const saved = await this.sessions.save(discarded.value);
      if (saved._tag === "err") {
        return err({ reason: "storage_failed" });
      }
      const reloaded = await this.sessions.load(
        input.profileId,
        input.sessionId,
      );
      if (
        reloaded._tag === "err" ||
        reloaded.value.batch !== undefined ||
        reloaded.value.batchContent !== undefined
      ) {
        return err({ reason: "storage_failed" });
      }
      return ok({
        session: reloaded.value,
        batch: undefined,
        revision: reloaded.value.updatedAt,
      });
    }

    if (durable.state._tag !== "Local") {
      return err({ reason: "batch_not_editable" });
    }
    if (isFindingCommand(input.command)) {
      const valid = await this.validateFindingCommand(input.profileId, input.sessionId, loaded.value, input.command);
      if (valid._tag === "err") return valid;
    }
    if (input.command._tag === "RepairInlineAnchor") {
      const valid = await validateRepairAnchor(loaded.value, input.command);
      if (valid._tag === "err") return valid;
    }
    const transitioned = applyLocalUpdate(
      durable,
      input.command,
      revision,
    );
    if (transitioned._tag === "err") {
      return transitioned;
    }

    const nextSession: ReviewSession = {
      ...loaded.value,
      batch: { state: transitioned.value.state },
      batchContent: transitioned.value,
      updatedAt: revision,
    };
    const saved = await this.sessions.save(nextSession);
    if (saved._tag === "err") {
      return err({ reason: "storage_failed" });
    }

    const reloaded = await this.sessions.load(
      input.profileId,
      input.sessionId,
    );
    if (reloaded._tag === "err" || reloaded.value.batchContent === undefined) {
      return err({ reason: "storage_failed" });
    }
    return ok({
      session: reloaded.value,
      batch: reloaded.value.batchContent,
      revision: reloaded.value.batchContent.updatedAt,
    });
  }

  private async validateFindingCommand(
    profileId: WorkspaceProfileId,
    sessionId: ReviewSessionId,
    session: ReviewSession,
    command: FindingCommand,
  ): Promise<Result<void, ReviewBatchControllerFailure>> {
    if (this.authority === undefined) return err({ reason: "invalid_input" });
    const review = await this.authority.reviews.load(profileId, command.reviewId);
    if (review._tag === "err" || review.value.status._tag !== "Open" || review.value.currentSessionId !== sessionId) return err({ reason: "invalid_input" });
    const analysis = await this.authority.insights.loadTyped(profileId, command.reviewId, "analysis", parseStoredAnalysis);
    if (analysis._tag === "err" || analysis.value.retained === undefined) return err({ reason: "invalid_input" });
    const retained = analysis.value.retained;
    if (retained.runId !== command.runId || retained.sessionId !== sessionId || retained.headSha !== session.key.headSha) return err({ reason: "invalid_input" });
    let patch: string;
    let patchHash: string;
    try {
      patch = await readFile(session.patchPath, "utf8");
      patchHash = await contentHash(session.patchPath);
    } catch {
      return err({ reason: "storage_failed" });
    }
    if (patchHash !== retained.patchHash) return err({ reason: "invalid_input" });
    const finding = retained.value.findings.find((candidate) => candidate.id === command.findingId);
    if (finding === undefined) return err({ reason: "invalid_input" });
    if (command._tag === "AddFindingGeneralComment") return ok(undefined);
    if (finding.mappingStatus !== "mapped" || finding.file !== command.anchor.path || finding.lineStart !== command.anchor.startLine || (finding.lineEnd ?? finding.lineStart) !== command.anchor.line || (finding.diffSide ?? "new") !== command.anchor.side) return err({ reason: "invalid_input" });
    const expected = fingerprintPatchAnchor(patch, command.anchor);
    return expected !== undefined && sameFingerprint(expected, command.fingerprint) ? ok(undefined) : err({ reason: "invalid_input" });
  }

}

type StoredAnalysis = {
  readonly runId: InsightRunId;
  readonly sessionId: ReviewSessionId;
  readonly headSha: GitSha;
  readonly patchHash: ContentHash;
  readonly value: ReviewResult;
};

function parseStoredAnalysis(input: unknown): Result<StoredAnalysis, unknown> {
  const revision = readObjectField(input, "revision");
  const runId = parseInsightRunId(readObjectField(input, "runId"));
  const sessionId = parseReviewSessionId(readObjectField(revision, "sessionId"));
  const headSha = parseGitSha(readObjectField(revision, "headSha"));
  const patchHash = parseContentHash(readObjectField(revision, "patchHash"));
  const value = parseReviewResult(readObjectField(input, "value"));
  if (runId._tag === "err" || sessionId._tag === "err" || headSha._tag === "err" || patchHash._tag === "err" || value._tag === "err") return err(undefined);
  return ok({ runId: runId.value, sessionId: sessionId.value, headSha: headSha.value, patchHash: patchHash.value, value: value.value });
}

async function validateRepairAnchor(
  session: ReviewSession,
  command: Extract<ReviewBatchUpdate, { readonly _tag: "RepairInlineAnchor" }>,
): Promise<Result<void, ReviewBatchControllerFailure>> {
  const current = session.batchContent?.items.find((item) => item.id === command.itemId);
  if (current === undefined || current._tag !== "InlineComment") return err({ reason: "item_not_found" });
  let patch: string;
  try {
    patch = await readFile(session.patchPath, "utf8");
  } catch {
    return err({ reason: "storage_failed" });
  }
  const expected = fingerprintPatchAnchor(patch, command.anchor);
  return expected !== undefined && sameFingerprint(expected, command.fingerprint) ? ok(undefined) : err({ reason: "invalid_input" });
}

function sameFingerprint(left: ReviewAnchorFingerprint, right: ReviewAnchorFingerprint): boolean {
  return left.path === right.path && left.side === right.side && left.startLine === right.startLine && left.line === right.line && sameStrings(left.selectedLines, right.selectedLines) && sameStrings(left.before, right.before) && sameStrings(left.after, right.after);
}

function sameStrings(left: ReadonlyArray<string>, right: ReadonlyArray<string>): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function parseUpdate(
  input: unknown,
): Result<ParsedUpdate, ReviewBatchControllerFailure> {
  const raw = v.safeParse(updateSchema, input);
  if (!raw.success) {
    return err({ reason: "invalid_input" });
  }
  const profileId = parseWorkspaceProfileId(raw.output.profileId);
  const sessionId = parseReviewSessionId(raw.output.sessionId);
  const expectedRevision = parseIsoTimestamp(raw.output.expectedRevision);
  if (
    profileId._tag === "err" ||
    sessionId._tag === "err" ||
    expectedRevision._tag === "err"
  ) {
    return err({ reason: "invalid_input" });
  }
  const command = parseCommand(raw.output.command);
  if (command._tag === "err") {
    return command;
  }
  return ok({
    profileId: profileId.value,
    sessionId: sessionId.value,
    expectedRevision: expectedRevision.value,
    command: command.value,
  });
}

function parseCommand(
  command: v.InferOutput<typeof commandSchema>,
): Result<ReviewBatchUpdate, ReviewBatchControllerFailure> {
  if (command._tag === "DiscardForRerun") {
    return command.acknowledgement
      ? ok({ _tag: "DiscardForRerun", acknowledgement: true })
      : err({ reason: "acknowledgement_required" });
  }
  if (command._tag === "UpdateBody") return ok({ _tag: "UpdateBody", body: command.body });
  if (command._tag === "SetSuggestedEvent") return ok({ _tag: "SetSuggestedEvent", event: command.event });
  if (command._tag === "SetItemIncluded") {
    const itemId = parseLocalReviewItemId(command.itemId);
    return itemId._tag === "err" ? err({ reason: "invalid_input" }) : ok({ _tag: "SetItemIncluded", itemId: itemId.value, include: command.include });
  }
  if (command._tag === "RepairInlineAnchor") {
    const itemId = parseLocalReviewItemId(command.itemId);
    const path = parseRepoRelativePath(command.anchor.path);
    const fingerprint = path._tag === "ok" ? parseFingerprint(command.fingerprint, path.value, command.anchor.startLine, command.anchor.line) : err({ reason: "invalid_input" as const });
    return itemId._tag === "err" || path._tag === "err" || fingerprint._tag === "err" || command.anchor.line < command.anchor.startLine ? err({ reason: "invalid_input" }) : ok({ _tag: "RepairInlineAnchor", itemId: itemId.value, anchor: { path: path.value, startLine: command.anchor.startLine, line: command.anchor.line, side: command.anchor.side }, fingerprint: fingerprint.value });
  }
  if (command._tag === "AddInlineComment") {
    const path = parseRepoRelativePath(command.anchor.path);
    if (
      path._tag === "err" ||
      command.anchor.line < command.anchor.startLine ||
      isEmptyBody(command.body)
    ) {
      return err({ reason: "invalid_input" });
    }
    const parsedFingerprint: Result<ReviewAnchorFingerprint | undefined, ReviewBatchControllerFailure> = command.fingerprint === undefined
      ? ok(undefined)
      : parseFingerprint(command.fingerprint, path.value, command.anchor.startLine, command.anchor.line);
    if (parsedFingerprint._tag === "err") return parsedFingerprint;
    return ok({
      _tag: "AddInlineComment",
      anchor: {
        path: path.value,
        startLine: command.anchor.startLine,
        line: command.anchor.line,
        side: command.anchor.side,
      },
      ...(parsedFingerprint.value === undefined ? {} : { fingerprint: parsedFingerprint.value }),
      body: command.body,
    });
  }
  if (command._tag === "AddFindingInlineComment") {
    const reviewId = parseReviewId(command.reviewId);
    const findingId = parseFindingId(command.findingId);
    const runId = parseInsightRunId(command.runId);
    const path = parseRepoRelativePath(command.anchor.path);
    const fingerprint = path._tag === "ok" ? parseFingerprint(command.fingerprint, path.value, command.anchor.startLine, command.anchor.line) : err({ reason: "invalid_input" as const });
    if (reviewId._tag === "err" || findingId._tag === "err" || runId._tag === "err" || path._tag === "err" || fingerprint._tag === "err" || command.anchor.line < command.anchor.startLine || isEmptyBody(command.body)) return err({ reason: "invalid_input" });
    return ok({ _tag: "AddFindingInlineComment", reviewId: reviewId.value, findingId: findingId.value, runId: runId.value, anchor: { path: path.value, startLine: command.anchor.startLine, line: command.anchor.line, side: command.anchor.side }, fingerprint: fingerprint.value, body: command.body });
  }
  if (command._tag === "AddFindingGeneralComment") {
    const reviewId = parseReviewId(command.reviewId);
    const findingId = parseFindingId(command.findingId);
    const runId = parseInsightRunId(command.runId);
    return reviewId._tag === "err" || findingId._tag === "err" || runId._tag === "err" || isEmptyBody(command.body)
      ? err({ reason: "invalid_input" })
      : ok({ _tag: "AddFindingGeneralComment", reviewId: reviewId.value, findingId: findingId.value, runId: runId.value, body: command.body });
  }
  if (command._tag === "AddGeneralComment") {
    return isEmptyBody(command.body)
      ? err({ reason: "invalid_input" })
      : ok({ _tag: "AddGeneralComment", body: command.body });
  }
  if (command._tag === "ConvertInlineToGeneral") {
    const itemId = parseLocalReviewItemId(command.itemId);
    return itemId._tag === "err" ? err({ reason: "invalid_input" }) : ok({ _tag: "ConvertInlineToGeneral", itemId: itemId.value });
  }
  if (command._tag === "EditItem" || command._tag === "RemoveItem") {
    const itemId = parseLocalReviewItemId(command.itemId);
    if (
      itemId._tag === "err" ||
      (command._tag === "EditItem" && isEmptyBody(command.body))
    ) {
      return err({ reason: "invalid_input" });
    }
    return command._tag === "EditItem"
      ? ok({ _tag: "EditItem", itemId: itemId.value, body: command.body })
      : ok({ _tag: "RemoveItem", itemId: itemId.value });
  }

  const threadId = parseGitHubThreadId(command.threadId);
  if (
    threadId._tag === "err" ||
    (command._tag === "AddThreadReply" && isEmptyBody(command.body))
  ) {
    return err({ reason: "invalid_input" });
  }
  return command._tag === "AddThreadReply"
    ? ok({
        _tag: "AddThreadReply",
        threadId: threadId.value,
        body: command.body,
      })
    : ok({
        _tag: "SetThreadState",
        threadId: threadId.value,
        action: command.action,
      });
}

function parseFingerprint(
  input: v.InferOutput<typeof fingerprintSchema>,
  anchorPath: ReviewAnchor["path"],
  anchorStartLine: number,
  anchorLine: number,
): Result<ReviewAnchorFingerprint, ReviewBatchControllerFailure> {
  const path = parseRepoRelativePath(input.path);
  if (
    path._tag === "err" ||
    path.value !== anchorPath ||
    input.side === undefined ||
    input.startLine !== anchorStartLine ||
    input.line !== anchorLine ||
    input.line < input.startLine ||
    input.selectedLines.length !== input.line - input.startLine + 1
  ) {
    return err({ reason: "invalid_input" });
  }
  return ok({
    path: path.value,
    side: input.side,
    startLine: input.startLine,
    line: input.line,
    selectedLines: input.selectedLines,
    before: input.before,
    after: input.after,
  });
}

function applyLocalUpdate(
  batch: ReviewBatch,
  command: Exclude<ReviewBatchUpdate, { readonly _tag: "DiscardForRerun" }>,
  updatedAt: IsoTimestamp,
): Result<ReviewBatch, ReviewBatchControllerFailure> {
  let items: ReadonlyArray<ReviewBatchItem>;
  if (command._tag === "UpdateBody") {
    const parsed = parseReviewBatch({ ...batch, summaryBody: command.body, updatedAt });
    return parsed._tag === "ok" ? parsed : err({ reason: "invalid_input" });
  } else if (command._tag === "SetSuggestedEvent") {
    const parsed = parseReviewBatch({ ...batch, suggestedEvent: command.event, updatedAt });
    return parsed._tag === "ok" ? parsed : err({ reason: "invalid_input" });
  } else if (command._tag === "SetItemIncluded") {
    if (!batch.items.some((item) => item.id === command.itemId)) return err({ reason: "item_not_found" });
    items = batch.items.map((item) => item.id === command.itemId ? { ...item, include: command.include } : item);
  } else if (command._tag === "RepairInlineAnchor") {
    const current = batch.items.find((item) => item.id === command.itemId);
    if (current === undefined || current._tag !== "InlineComment") return err({ reason: "item_not_found" });
    items = batch.items.map((item) => {
      if (item.id !== command.itemId || item._tag !== "InlineComment") return item;
      const { attention: _attention, ...withoutAttention } = item;
      void _attention;
      return { ...withoutAttention, anchor: command.anchor, fingerprint: command.fingerprint, postability: "postable" as const };
    });
  } else if (command._tag === "AddInlineComment") {
    const id = nextItemId("manual-1", batch.items);
    if (id === undefined) {
      return err({ reason: "invalid_input" });
    }
    items = [
      ...batch.items,
      {
        _tag: "InlineComment",
        id,
        provenance: { _tag: "human" },
        source: "manual",
        anchor: command.anchor,
        ...(command.fingerprint === undefined ? {} : { fingerprint: command.fingerprint }),
        body: command.body,
        include: true,
        postability: "postable",
      },
    ];
  } else if (command._tag === "AddFindingInlineComment") {
    const id = nextItemId("finding-inline-1", batch.items);
    if (id === undefined) return err({ reason: "invalid_input" });
    items = [...batch.items, {
      _tag: "InlineComment",
      id,
      provenance: { _tag: "insight", runId: command.runId },
      source: "finding",
      findingId: command.findingId,
      anchor: command.anchor,
      fingerprint: command.fingerprint,
      body: command.body,
      include: true,
      postability: "postable",
    }];
  } else if (command._tag === "AddFindingGeneralComment") {
    const id = nextItemId("finding-general-1", batch.items);
    if (id === undefined) return err({ reason: "invalid_input" });
    items = [...batch.items, {
      _tag: "GeneralComment",
      id,
      provenance: { _tag: "insight", runId: command.runId },
      source: "finding",
      findingId: command.findingId,
      body: command.body,
      include: true,
    }];
  } else if (command._tag === "AddGeneralComment") {
    const id = nextItemId("general-1", batch.items);
    if (id === undefined) return err({ reason: "invalid_input" });
    items = [...batch.items, {
      _tag: "GeneralComment",
      id,
      provenance: { _tag: "human" },
      source: "manual",
      body: command.body,
      include: true,
    }];
  } else if (command._tag === "ConvertInlineToGeneral") {
    const current = batch.items.find((item) => item.id === command.itemId);
    if (current === undefined || current._tag !== "InlineComment") return err({ reason: "item_not_found" });
    const converted: ReviewBatchItem = {
      _tag: "GeneralComment",
      id: current.id,
      provenance: current.provenance,
      source: current.source,
      ...(current.findingId === undefined ? {} : { findingId: current.findingId }),
      body: current.body,
      include: current.include,
      ...(current.carriedFrom === undefined ? {} : { carriedFrom: current.carriedFrom }),
    };
    items = batch.items.map((item) => item.id === command.itemId ? converted : item);
  } else if (command._tag === "EditItem") {
    const current = batch.items.find((item) => item.id === command.itemId);
    if (current === undefined) {
      return err({ reason: "item_not_found" });
    }
    if (current._tag === "ThreadState") {
      return err({ reason: "invalid_input" });
    }
    items = batch.items.map((item) =>
      item.id === command.itemId ? { ...item, body: command.body } : item,
    );
  } else if (command._tag === "RemoveItem") {
    if (!batch.items.some((item) => item.id === command.itemId)) {
      return err({ reason: "item_not_found" });
    }
    items = batch.items.filter((item) => item.id !== command.itemId);
  } else if (command._tag === "AddThreadReply") {
    if (
      batch.items.some(
        (item) =>
          item._tag === "ThreadReply" &&
          item.threadId === command.threadId,
      )
    ) {
      return err({ reason: "duplicate_thread_action" });
    }
    const id = nextItemId(`reply-${command.threadId}`, batch.items);
    if (id === undefined) {
      return err({ reason: "invalid_input" });
    }
    items = [
      ...batch.items,
      {
        _tag: "ThreadReply",
        id,
        provenance: { _tag: "human" },
        threadId: command.threadId,
        body: command.body,
        include: true,
      },
    ];
  } else {
    if (
      batch.items.some(
        (item) =>
          item._tag === "ThreadState" &&
          item.threadId === command.threadId,
      )
    ) {
      return err({ reason: "duplicate_thread_action" });
    }
    const id = nextItemId(
      `thread-state-${command.threadId}`,
      batch.items,
    );
    if (id === undefined) {
      return err({ reason: "invalid_input" });
    }
    items = [
      ...batch.items,
      {
        _tag: "ThreadState",
        id,
        provenance: { _tag: "human" },
        threadId: command.threadId,
        action: command.action,
        include: true,
      },
    ];
  }

  const parsed = parseReviewBatch({ ...batch, items, updatedAt });
  return parsed._tag === "ok"
    ? parsed
    : err({ reason: "invalid_input" });
}

function nextItemId(
  base: string,
  items: ReadonlyArray<ReviewBatchItem>,
): LocalReviewItemId | undefined {
  const used = new Set(items.map((item) => item.id));
  let suffix = 1;
  while (suffix <= Number.MAX_SAFE_INTEGER) {
    const candidate = parseLocalReviewItemId(
      suffix === 1 ? base : `${base}-${suffix}`,
    );
    if (candidate._tag === "err") {
      return undefined;
    }
    if (!used.has(candidate.value)) {
      return candidate.value;
    }
    suffix += 1;
  }
  return undefined;
}

function isEmptyBody(body: string): boolean {
  return body.trim().length === 0;
}

function nextRevision(
  previous: IsoTimestamp,
  candidate: IsoTimestamp,
): IsoTimestamp {
  if (candidate > previous) {
    return candidate;
  }
  const previousMilliseconds = Date.parse(previous);
  return mustParseRevision(
    new Date(previousMilliseconds + 1).toISOString(),
  );
}

function mustParseRevision(value: string): IsoTimestamp {
  const parsed = parseIsoTimestamp(value);
  if (parsed._tag === "err") {
    throw new Error("Could not advance review batch revision");
  }
  return parsed.value;
}
