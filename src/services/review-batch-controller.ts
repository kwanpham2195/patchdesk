import * as v from "valibot";

import type { ReviewSessionStore } from "../adapters/storage/review-session-store";
import {
  parseGitHubThreadId,
  parseIsoTimestamp,
  parseLocalReviewItemId,
  parseRepoRelativePath,
  parseReviewAttemptId,
  parseReviewSessionId,
  parseWorkspaceProfileId,
  type GitHubThreadId,
  type IsoTimestamp,
  type LocalReviewItemId,
} from "../domain/ids";
import {
  parseReviewBatch,
  type ReviewAnchor,
  type ReviewBatch,
  type ReviewBatchItem,
} from "../domain/review-batch";
import {
  discardBatchForRerun,
  type ReviewSession,
} from "../domain/review-session";
import { err, ok, type Result } from "../domain/result";

const anchorSchema = v.strictObject({
  path: v.string(),
  startLine: v.pipe(v.number(), v.integer(), v.minValue(1)),
  line: v.pipe(v.number(), v.integer(), v.minValue(1)),
  side: v.picklist(["new", "old"]),
});

const commandSchema = v.variant("_tag", [
  v.strictObject({
    _tag: v.literal("AddInlineComment"),
    anchor: anchorSchema,
    body: v.string(),
  }),
  v.strictObject({
    _tag: v.literal("EditItem"),
    itemId: v.string(),
    body: v.string(),
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
  attemptId: v.string(),
  expectedRevision: v.string(),
  command: commandSchema,
});

/** One parsed local review-batch edit. */
export type ReviewBatchUpdate =
  | {
      readonly _tag: "AddInlineComment";
      readonly anchor: ReviewAnchor;
      readonly body: string;
    }
  | {
      readonly _tag: "EditItem";
      readonly itemId: LocalReviewItemId;
      readonly body: string;
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

type ParsedUpdate = {
  readonly profileId: ReviewSession["key"]["profileId"];
  readonly sessionId: ReviewSession["id"];
  readonly attemptId: ReviewBatch["attemptId"];
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
  private readonly locks = new Map<string, Promise<void>>();

  constructor(
    private readonly sessions: ReviewSessionStore,
    private readonly now: () => IsoTimestamp,
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
    return this.exclusive(key, async () =>
      this.updateExclusive(parsed.value),
    );
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
      loaded.value.currentAttemptId !== input.attemptId ||
      durable.attemptId !== input.attemptId ||
      durable.sessionId !== loaded.value.id
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

  private async exclusive<T>(
    key: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => gate);
    this.locks.set(key, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.locks.get(key) === tail) {
        this.locks.delete(key);
      }
    }
  }
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
  const attemptId = parseReviewAttemptId(raw.output.attemptId);
  const expectedRevision = parseIsoTimestamp(raw.output.expectedRevision);
  if (
    profileId._tag === "err" ||
    sessionId._tag === "err" ||
    attemptId._tag === "err" ||
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
    attemptId: attemptId.value,
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
  if (command._tag === "AddInlineComment") {
    const path = parseRepoRelativePath(command.anchor.path);
    if (
      path._tag === "err" ||
      command.anchor.line < command.anchor.startLine ||
      isEmptyBody(command.body)
    ) {
      return err({ reason: "invalid_input" });
    }
    return ok({
      _tag: "AddInlineComment",
      anchor: {
        path: path.value,
        startLine: command.anchor.startLine,
        line: command.anchor.line,
        side: command.anchor.side,
      },
      body: command.body,
    });
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

function applyLocalUpdate(
  batch: ReviewBatch,
  command: Exclude<ReviewBatchUpdate, { readonly _tag: "DiscardForRerun" }>,
  updatedAt: IsoTimestamp,
): Result<ReviewBatch, ReviewBatchControllerFailure> {
  let items: ReadonlyArray<ReviewBatchItem>;
  if (command._tag === "AddInlineComment") {
    const id = nextItemId("manual-1", batch.items);
    if (id === undefined) {
      return err({ reason: "invalid_input" });
    }
    items = [
      ...batch.items,
      {
        _tag: "InlineComment",
        id,
        source: "manual",
        anchor: command.anchor,
        body: command.body,
        include: true,
        postability: "postable",
      },
    ];
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
