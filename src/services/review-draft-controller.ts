import * as v from "valibot";

import type { ReviewSessionStore } from "../adapters/storage/review-session-store";
import {
  parseFindingId,
  parseIsoTimestamp,
  parseReviewSessionId,
  parseWorkspaceProfileId,
  type IsoTimestamp,
} from "../domain/ids";
import { parseReviewDraft, type ReviewDraft } from "../domain/review-draft";
import type { ReviewSession } from "../domain/review-session";
import { err, ok, type Result } from "../domain/result";

const updateSchema = v.strictObject({
  profileId: v.string(),
  sessionId: v.string(),
  expectedRevision: v.string(),
  summaryBody: v.string(),
  comments: v.array(
    v.strictObject({
      findingId: v.string(),
      include: v.boolean(),
      body: v.string(),
    }),
  ),
});

type DraftEdit = {
  readonly findingId: ReviewDraft["comments"][number]["findingId"];
  readonly include: boolean;
  readonly body: string;
};

type ParsedUpdate = {
  readonly profileId: ReviewSession["key"]["profileId"];
  readonly sessionId: ReviewSession["id"];
  readonly expectedRevision: IsoTimestamp;
  readonly summaryBody: string;
  readonly comments: ReadonlyArray<DraftEdit>;
};

export type ReviewDraftUpdate = {
  readonly session: ReviewSession;
  readonly draft: ReviewDraft;
  /** The exact persisted draft revision to send as expectedRevision on the next save. */
  readonly revision: IsoTimestamp;
};

export type ReviewDraftControllerFailure = {
  readonly reason:
    | "invalid_input"
    | "session_not_found"
    | "draft_not_found"
    | "draft_not_editable"
    | "draft_attempt_mismatch"
    | "revision_conflict"
    | "draft_shape_mismatch"
    | "storage_failed";
};

/**
 * Owns authoritative local-draft edits.
 *
 * The renderer supplies only user-editable fields. Verified GitHub locations,
 * postability, original suggestions, identity, and lifecycle state always come
 * from the durable draft. updatedAt is the compare-and-set revision token.
 */
export class ReviewDraftController {
  private readonly locks = new Map<string, Promise<void>>();

  constructor(
    private readonly sessions: ReviewSessionStore,
    private readonly now: () => IsoTimestamp,
  ) {}

  async update(
    input: unknown,
  ): Promise<Result<ReviewDraftUpdate, ReviewDraftControllerFailure>> {
    const parsed = parseUpdate(input);
    if (parsed._tag === "err") return parsed;
    const key = `${parsed.value.profileId}:${parsed.value.sessionId}`;
    return this.exclusive(key, async () => this.updateExclusive(parsed.value));
  }

  private async updateExclusive(
    input: ParsedUpdate,
  ): Promise<Result<ReviewDraftUpdate, ReviewDraftControllerFailure>> {
    const loaded = await this.sessions.load(input.profileId, input.sessionId);
    if (loaded._tag === "err") {
      return err({
        reason:
          loaded.error.reason === "not_found"
            ? "session_not_found"
            : "storage_failed",
      });
    }

    const durable = loaded.value.draftContent;
    if (durable === undefined) return err({ reason: "draft_not_found" });
    if (
      loaded.value.currentAttemptId !== durable.attemptId ||
      durable.sessionId !== loaded.value.id
    ) {
      return err({ reason: "draft_attempt_mismatch" });
    }
    if (durable.state._tag !== "LocalDraft") {
      return err({ reason: "draft_not_editable" });
    }
    if (durable.updatedAt !== input.expectedRevision) {
      return err({ reason: "revision_conflict" });
    }

    const edits = new Map(input.comments.map((comment) => [comment.findingId, comment]));
    if (
      edits.size !== input.comments.length ||
      edits.size !== durable.comments.length ||
      durable.comments.some((comment) => !edits.has(comment.findingId))
    ) {
      return err({ reason: "draft_shape_mismatch" });
    }

    const revision = nextRevision(durable.updatedAt, this.now());
    const candidate = parseReviewDraft({
      ...durable,
      summaryBody: input.summaryBody,
      comments: durable.comments.map((comment) => {
        const edit = edits.get(comment.findingId);
        // The shape check above proves this branch cannot be reached.
        return edit === undefined
          ? comment
          : { ...comment, include: edit.include, body: edit.body };
      }),
      updatedAt: revision,
    });
    if (candidate._tag === "err") return err({ reason: "invalid_input" });

    const nextSession: ReviewSession = {
      ...loaded.value,
      draft: { state: candidate.value.state },
      draftContent: candidate.value,
      updatedAt: revision,
    };
    const saved = await this.sessions.save(nextSession);
    if (saved._tag === "err") return err({ reason: "storage_failed" });

    // Return the exact canonical value accepted by the durable store, rather
    // than trusting the pre-persistence candidate as a projection of it.
    const reloaded = await this.sessions.load(input.profileId, input.sessionId);
    if (reloaded._tag === "err" || reloaded.value.draftContent === undefined) {
      return err({ reason: "storage_failed" });
    }
    return ok({
      session: reloaded.value,
      draft: reloaded.value.draftContent,
      revision: reloaded.value.draftContent.updatedAt,
    });
  }

  private async exclusive<T>(key: string, operation: () => Promise<T>): Promise<T> {
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
      if (this.locks.get(key) === tail) this.locks.delete(key);
    }
  }
}

function parseUpdate(
  input: unknown,
): Result<ParsedUpdate, ReviewDraftControllerFailure> {
  const raw = v.safeParse(updateSchema, input);
  if (!raw.success) return err({ reason: "invalid_input" });
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
  const comments: DraftEdit[] = [];
  for (const comment of raw.output.comments) {
    const findingId = parseFindingId(comment.findingId);
    if (findingId._tag === "err") return err({ reason: "invalid_input" });
    comments.push({ ...comment, findingId: findingId.value });
  }
  return ok({
    profileId: profileId.value,
    sessionId: sessionId.value,
    expectedRevision: expectedRevision.value,
    summaryBody: raw.output.summaryBody,
    comments,
  });
}

function nextRevision(previous: IsoTimestamp, candidate: IsoTimestamp): IsoTimestamp {
  if (candidate > previous) return candidate;
  return new Date(Date.parse(previous) + 1).toISOString() as IsoTimestamp;
}
