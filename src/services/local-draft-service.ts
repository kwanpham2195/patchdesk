import { readFile } from "node:fs/promises";

import type { InsightStore } from "../adapters/storage/insight-store";
import type { ReviewSessionStore } from "../adapters/storage/review-session-store";
import type { ReviewStore } from "../adapters/storage/review-store";
import { definedProps } from "../domain/defined-props";
import { fingerprintPatchAnchor } from "../domain/diff-anchor";
import { resolveSuggestionTarget } from "../domain/finding-suggestion";
import {
  parseContentHash,
  parseRepoRelativePath,
  type FindingId,
  type InsightRunId,
  type IsoTimestamp,
  type LocalNoteId,
  type RepoRelativePath,
  type ReviewId,
  type WorkspaceProfileId,
} from "../domain/ids";
import { sameInsightRevision } from "../domain/insight-record";
import {
  parseMaintainerNoteText,
  projectLocalDraft,
  type LocalDraft,
  type LocalDraftEntry,
  type MaintainerNote,
} from "../domain/local-draft";
import { renderLocalDraftsAsAgentPrompt } from "../domain/local-draft-agent-prompt";
import { mapFindingLocation, parseUnifiedPatch } from "../domain/patch";
import { err, ok, type Result } from "../domain/result";
import {
  addLocalDraft,
  editMaintainerNote,
  isLocalReview,
  removeLocalDraft,
  type Review,
} from "../domain/review";
import { parseReviewResult } from "../domain/review-result";
import type { LocalReviewSource } from "../domain/review-source";
import { hashReviewArtifactContent } from "./review-artifact-hash";
import type { ReviewOperationCoordinator } from "./review-operation-coordinator";

type ReviewKey = {
  readonly profileId: WorkspaceProfileId;
  readonly reviewId: ReviewId;
};

/** Identity only: the main process reads the Finding, its anchor, and its suggestion itself. */
export type LocalDraftRequest = ReviewKey & {
  readonly runId: InsightRunId;
  readonly findingId: FindingId;
};

/** A new maintainer note: the lines the maintainer selected and the text; the main process fingerprints the anchor. */
export type LocalNoteRequest = ReviewKey & {
  readonly anchor: {
    readonly path: RepoRelativePath;
    readonly side: "new" | "old";
    readonly startLine: number;
    readonly line: number;
  };
  readonly text: string;
};

export type LocalNoteEditRequest = ReviewKey & {
  readonly noteId: LocalNoteId;
  readonly text: string;
};

export type LocalDraftFailure = {
  readonly reason:
    | "in_progress"
    | "not_found"
    | "terminal"
    /** Not a local Review; the Finding is not a current, open, Mapped Finding; or a note's lines are not in the current patch. */
    | "not_applicable"
    /** A note's text is empty or longer than the comment limit. */
    | "invalid_input"
    | "storage";
};

export type LocalDraftList = {
  readonly localDrafts: ReadonlyArray<LocalDraftEntry>;
};

type LocalDraftDependencies = {
  readonly reviews: Pick<ReviewStore, "load" | "save">;
  readonly sessions: Pick<ReviewSessionStore, "load">;
  readonly insights: Pick<InsightStore, "loadTyped">;
  readonly coordinator: Pick<ReviewOperationCoordinator, "acquire" | "release">;
  readonly now: () => IsoTimestamp;
  readonly createNoteId: () => LocalNoteId;
};

/**
 * Add to draft, maintainer notes, and Remove on a local Review (ADR 0050
 * "Local drafts", ADR 0051): a local store write under the Review
 * coordinator. No freshness gate, because nothing outside Patchdesk changes.
 */
export class LocalDraftService {
  constructor(private readonly dependencies: LocalDraftDependencies) {}

  add(
    request: LocalDraftRequest,
  ): Promise<Result<LocalDraftList, LocalDraftFailure>> {
    return this.locked(request, async (review) => {
      const draft = await this.draftFor(review, request);
      return draft._tag === "err"
        ? draft
        : openReviewChange(addLocalDraft(review, draft.value));
    });
  }

  /** Needs no Analysis: a draft from an older session is removed by its identity alone. */
  remove(
    request: LocalDraftRequest,
  ): Promise<Result<LocalDraftList, LocalDraftFailure>> {
    return this.locked(request, async (review) =>
      openReviewChange(
        removeLocalDraft(review, request, this.dependencies.now()),
      ),
    );
  }

  /** A note on lines of the current session's patch; lines the patch does not show are refused. */
  addNote(
    request: LocalNoteRequest,
  ): Promise<Result<LocalDraftList, LocalDraftFailure>> {
    const text = parseMaintainerNoteText(request.text);
    if (text._tag === "err")
      return Promise.resolve(err({ reason: "invalid_input" }));
    return this.locked(request, async (review) => {
      const note = await this.noteFor(review, request, text.value);
      return note._tag === "err"
        ? note
        : openReviewChange(addLocalDraft(review, note.value));
    });
  }

  editNote(
    request: LocalNoteEditRequest,
  ): Promise<Result<LocalDraftList, LocalDraftFailure>> {
    const text = parseMaintainerNoteText(request.text);
    if (text._tag === "err")
      return Promise.resolve(err({ reason: "invalid_input" }));
    return this.locked(request, async (review) =>
      openReviewChange(
        editMaintainerNote(review, {
          noteId: request.noteId,
          text: text.value,
          updatedAt: this.dependencies.now(),
        }),
      ),
    );
  }

  removeNote(
    request: ReviewKey & { readonly noteId: LocalNoteId },
  ): Promise<Result<LocalDraftList, LocalDraftFailure>> {
    return this.locked(request, async (review) =>
      openReviewChange(
        removeLocalDraft(
          review,
          { noteId: request.noteId },
          this.dependencies.now(),
        ),
      ),
    );
  }

  /** The Local drafts as one prompt for the coding agent; a read, so it takes no lock. */
  async agentPrompt(
    profileId: WorkspaceProfileId,
    reviewId: ReviewId,
  ): Promise<Result<{ readonly markdown: string }, LocalDraftFailure>> {
    const loaded = await this.dependencies.reviews.load(profileId, reviewId);
    if (loaded._tag === "err")
      return err({
        reason: loaded.error.reason === "not_found" ? "not_found" : "storage",
      });
    if (!isLocalReview(loaded.value)) return err({ reason: "not_applicable" });
    return ok({
      markdown: renderLocalDraftsAsAgentPrompt(loaded.value.localDrafts ?? []),
    });
  }

  private async locked(
    request: ReviewKey,
    change: (
      review: Review<LocalReviewSource>,
    ) => Promise<Result<Review<LocalReviewSource>, LocalDraftFailure>>,
  ): Promise<Result<LocalDraftList, LocalDraftFailure>> {
    const key = `${request.profileId}:${request.reviewId}`;
    if (!this.dependencies.coordinator.acquire(key))
      return err({ reason: "in_progress" });
    try {
      const loaded = await this.dependencies.reviews.load(
        request.profileId,
        request.reviewId,
      );
      if (loaded._tag === "err")
        return err({
          reason: loaded.error.reason === "not_found" ? "not_found" : "storage",
        });
      const review = loaded.value;
      if (!isLocalReview(review)) return err({ reason: "not_applicable" });
      const changed = await change(review);
      if (changed._tag === "err") return changed;
      const next = changed.value;
      if (next !== review) {
        const saved = await this.dependencies.reviews.save(
          next,
          review.updatedAt,
        );
        if (saved._tag === "err") return err({ reason: "storage" });
      }
      return ok({
        localDrafts: (next.localDrafts ?? []).map(projectLocalDraft),
      });
    } finally {
      this.dependencies.coordinator.release(key);
    }
  }

  private async noteFor(
    review: Review<LocalReviewSource>,
    request: LocalNoteRequest,
    text: string,
  ): Promise<Result<MaintainerNote, LocalDraftFailure>> {
    const session = await this.dependencies.sessions.load(
      request.profileId,
      review.currentSessionId,
    );
    if (session._tag === "err") return err({ reason: "storage" });
    const patch = await readFile(session.value.patchPath, "utf8").catch(
      () => undefined,
    );
    if (patch === undefined) return err({ reason: "storage" });
    const anchor = fingerprintPatchAnchor(patch, request.anchor);
    if (anchor === undefined) return err({ reason: "not_applicable" });
    const now = this.dependencies.now();
    return ok({
      author: "maintainer",
      noteId: this.dependencies.createNoteId(),
      sessionId: session.value.id,
      anchor,
      text,
      createdAt: now,
      updatedAt: now,
    });
  }

  /**
   * The draft for one open Mapped Finding of the Analysis retained for the
   * Review's current session, anchored and fingerprinted against that
   * session's patch on disk.
   */
  private async draftFor(
    review: Review<LocalReviewSource>,
    request: LocalDraftRequest,
  ): Promise<Result<LocalDraft, LocalDraftFailure>> {
    const [session, record] = await Promise.all([
      this.dependencies.sessions.load(
        request.profileId,
        review.currentSessionId,
      ),
      this.dependencies.insights.loadTyped(
        request.profileId,
        request.reviewId,
        "analysis",
        parseReviewResult,
      ),
    ]);
    if (session._tag === "err" || record._tag === "err")
      return err({ reason: "storage" });
    const retained = record.value.retained;
    if (retained === undefined || retained.runId !== request.runId)
      return err({ reason: "not_found" });
    const patch = await readFile(session.value.patchPath, "utf8").catch(
      () => undefined,
    );
    if (patch === undefined) return err({ reason: "storage" });
    const patchHash = parseContentHash(hashReviewArtifactContent(patch));
    if (patchHash._tag === "err") return err({ reason: "storage" });
    if (
      !sameInsightRevision(retained.revision, {
        sessionId: session.value.id,
        headSha: session.value.key.headSha,
        patchHash: patchHash.value,
      })
    )
      return err({ reason: "not_applicable" });
    const finding = retained.value.findings.find(
      (candidate) => candidate.id === request.findingId,
    );
    if (finding === undefined) return err({ reason: "not_found" });
    if (
      record.value.dismissals?.some(
        (dismissal) => dismissal.findingId === request.findingId,
      ) === true
    )
      return err({ reason: "not_applicable" });
    const location = mapFindingLocation(parseUnifiedPatch(patch), finding);
    const path =
      location.path === undefined
        ? undefined
        : parseRepoRelativePath(location.path);
    if (
      location.mappingStatus !== "mapped" ||
      path?._tag !== "ok" ||
      location.side === undefined ||
      location.line === undefined
    )
      return err({ reason: "not_applicable" });
    const anchor = fingerprintPatchAnchor(patch, {
      path: path.value,
      side: location.side,
      startLine: location.startLine ?? location.line,
      line: location.line,
    });
    if (anchor === undefined) return err({ reason: "not_applicable" });
    const code = finding.suggestedReplacement?.code;
    // Only a replacement that still resolves in this patch travels with the draft.
    const suggestion =
      code !== undefined &&
      resolveSuggestionTarget(patch, finding) !== undefined
        ? { code }
        : undefined;
    return ok({
      findingId: finding.id,
      analysisRunId: retained.runId,
      sessionId: session.value.id,
      anchor,
      title: finding.title,
      comment: finding.suggestedComment ?? finding.explanation,
      ...definedProps({ suggestion }),
      addedAt: this.dependencies.now(),
    });
  }
}

/** A Local draft change the Review domain refused, as the failure the route answers with. */
function openReviewChange(
  changed: Result<
    Review<LocalReviewSource>,
    { readonly _tag: "ReviewTerminal" | "NoteNotFound" }
  >,
): Result<Review<LocalReviewSource>, LocalDraftFailure> {
  if (changed._tag === "ok") return changed;
  return err({
    reason: changed.error._tag === "NoteNotFound" ? "not_found" : "terminal",
  });
}
