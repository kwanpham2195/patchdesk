import { readFile } from "node:fs/promises";

import { containsSensitiveData } from "../adapters/storage/json-file";
import type { InsightStore } from "../adapters/storage/insight-store";
import type { ReviewSessionStore } from "../adapters/storage/review-session-store";
import type { ReviewStore } from "../adapters/storage/review-store";
import { definedProps } from "../domain/defined-props";
import type { FailureKinds } from "../domain/failure-kind";
import {
  readFeedbackHandoff,
  type FeedbackHandoffReading,
  type FeedbackHandoffVerdict,
} from "../domain/feedback-handoff";
import { fingerprintPatchAnchor } from "../domain/diff-anchor";
import {
  isAcceptableSuggestionCode,
  resolveSuggestionTarget,
} from "../domain/finding-suggestion";
import {
  parseContentHash,
  parseRepoRelativePath,
  type FindingId,
  type InsightRunId,
  type IsoTimestamp,
  type LocalNoteId,
  type RepoRelativePath,
  type ReviewId,
  type ReviewSessionId,
  type WorkspaceProfileId,
} from "../domain/ids";
import { sameInsightRevision } from "../domain/insight-record";
import {
  isMaintainerNote,
  localDraftFeedbackState,
  parseMaintainerNoteText,
  projectLocalDraft,
  type LocalDraft,
  type LocalDraftEntry,
  type LocalDraftFeedbackState,
  type LocalDraftTarget,
  type MaintainerNote,
} from "../domain/local-draft";
import {
  localDraftId,
  localDraftTargetId,
  parseLocalDraftId,
  parseLocalDraftReplyText,
  type LocalDraftReply,
  type LocalDraftReplyStatus,
} from "../domain/local-draft-reply";
import { renderLocalDraftsAsAgentPrompt } from "../domain/local-draft-agent-prompt";
import {
  indexPatchHunks,
  placeInView,
  type LocalPatchView,
  type LocalPatchViewPaths,
} from "../domain/local-patch-view";
import { mapFindingLocation, parseUnifiedPatch } from "../domain/patch";
import { err, ok, type Result } from "../domain/result";
import { isLocalReview, type Review } from "../domain/review";
import {
  addLocalDraft,
  editMaintainerNote,
  recordFeedbackHandoff,
  removeLocalDraft,
  replyToLocalDraft,
  setLocalDraftResolved,
} from "../domain/review-local-drafts";
import { parseReviewResult } from "../domain/review-result";
import {
  isPullRequestReviewSession,
  type LocalSessionViewPatch,
} from "../domain/review-session";
import type { LocalReviewSource } from "../domain/review-source";
import {
  pageLocalDrafts,
  type LocalFeedbackPageFailure,
} from "./local-feedback-page";
import { hashReviewArtifactContent } from "./review-artifact-hash";
import type { ReviewOperationCoordinator } from "./review-operation-coordinator";
import {
  describeCurrentSession,
  type CurrentSession,
  type ReviewSessionDescription,
} from "./review-session-description";

/**
 * Every draft write names the session the workbench displays, so a write made
 * on a view the Review has since moved past is refused (#452).
 */
type ReviewKey = {
  readonly profileId: WorkspaceProfileId;
  readonly reviewId: ReviewId;
  readonly sessionId: ReviewSessionId;
};

/** Identity only: the main process reads the Finding, its anchor, and its suggestion itself. */
export type LocalDraftRequest = ReviewKey & {
  readonly runId: InsightRunId;
  readonly findingId: FindingId;
};

/** A new maintainer note: the lines the maintainer selected on one patch view and the text; the main process fingerprints the anchor. */
export type LocalNoteRequest = ReviewKey & {
  /** Only a shared local Review has views other than Combined (ADR 0050). */
  readonly view: LocalPatchView;
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

/** Ready for agent: the maintainer hands the drafts on the named session to the coding agent. */
export type FeedbackHandoffRequest = ReviewKey & {
  readonly verdict?: FeedbackHandoffVerdict;
};

/** Resolve or Reopen on one draft; only the maintainer sends it. */
export type LocalDraftResolveRequest = ReviewKey & {
  readonly draft: LocalDraftTarget;
  readonly resolved: boolean;
};

/** The coding agent's reply to one draft (ADR 0052 `reply_to_note`); it names no session, since a draft keeps its id across moves. */
export type LocalDraftReplyRequest = {
  readonly profileId: WorkspaceProfileId;
  readonly reviewId: ReviewId;
  /** A `localDraftId` as `get_feedback` listed it. */
  readonly draftId: string;
  readonly status: LocalDraftReplyStatus;
  readonly text: string;
};

/** What `reply_to_note` answers: the stored reply, and whether the maintainer already resolved the draft. */
export type LocalDraftReplied = {
  readonly draftId: string;
  readonly status: LocalDraftReplyStatus;
  readonly repliedAt: IsoTimestamp;
  readonly resolved: boolean;
};

export type LocalDraftFailure = {
  readonly reason:
    | "in_progress"
    | "not_found"
    | "terminal"
    /** Not a local Review; the Review moved to another session than the one named; the Finding is not a current, open, Mapped Finding; or a note's lines are not in the named view's patch, or the session has no such view. */
    | "not_applicable"
    /** A note's or reply's text is empty or longer than its limit. */
    | "invalid_input"
    /** The draft holds a credential-shaped value, which Patchdesk never stores. */
    | "draft_sensitive"
    /** A reply holds a credential-shaped value. */
    | "reply_sensitive"
    /** The Review has no draft with that id, as after the maintainer removed it. */
    | "draft_not_found"
    | "storage";
};

/** What taking the Review lock and loading the Review can refuse with. */
type LocalDraftLockFailure = {
  readonly reason: "in_progress" | "not_found" | "storage";
};

/** What `reply_to_note` can refuse with; it never writes the drafts, so never `draft_sensitive`. */
export type LocalDraftReplyFailure = {
  readonly reason: Exclude<LocalDraftFailure["reason"], "draft_sensitive">;
};

/** What a read of the Local drafts can refuse with; a read never writes, so never `draft_sensitive`. */
type LocalDraftReadFailure = {
  readonly reason: "not_found" | "not_applicable" | "storage";
};

/** How each Local draft refusal is classified (ADR 0052 "Error model"). */
export const localDraftFailureKinds = {
  invalid_input: "invalid",
  draft_sensitive: "invalid",
  reply_sensitive: "invalid",
  draft_not_found: "not_found",
  stale_cursor: "conflict",
  not_found: "not_found",
  in_progress: "conflict",
  terminal: "conflict",
  not_applicable: "conflict",
  storage: "unavailable",
} as const satisfies FailureKinds<
  LocalDraftFailure["reason"] | LocalFeedbackPageFailure["reason"]
>;

/**
 * What every Local draft write answers with; the hand-off is absent when the
 * Review has none. The agent's replies ride along, so a removal that drops a
 * reply clears it on screen at once.
 */
export type LocalDraftList = {
  readonly localDrafts: ReadonlyArray<LocalDraftEntry>;
  readonly localDraftReplies: ReadonlyArray<LocalDraftReply>;
  readonly feedbackHandoff?: FeedbackHandoffReading;
};

/** Omits `state` and `resolvedAt` from each member of a union, keeping the members apart. */
type WithoutState<Entry> = Entry extends unknown
  ? Omit<Entry, "state" | "resolvedAt">
  : never;

/**
 * A draft as the workbench lists it, with a state always present: `current`
 * for a draft written on the Review's current session, which the workbench
 * leaves unlabelled. `inline` says whether its lines sit inside a hunk of its
 * origin view on the current session. `draftId` is what `reply_to_note`
 * names, `resolved` says the maintainer resolved it, and `reply` is the
 * agent's latest reply. A Finding draft adds its comment and verified
 * suggestion.
 */
type LocalFeedbackEntry = WithoutState<LocalDraftEntry> & {
  readonly draftId: string;
  readonly state: LocalDraftFeedbackState;
  readonly inline: boolean;
  readonly resolved: boolean;
  readonly reply?: Omit<LocalDraftReply, "draft">;
  readonly comment?: string;
  readonly suggestion?: string;
};

/**
 * What the coding agent reads back (ADR 0052 `get_feedback`): one page of
 * Local drafts, the prompt that page renders as, the session the Review is
 * on, and the hand-off with `changedSinceHandoff` when the maintainer made one.
 */
export type LocalFeedback = ReviewSessionDescription &
  Partial<FeedbackHandoffReading> & {
    readonly localDrafts: ReadonlyArray<LocalFeedbackEntry>;
    readonly markdown: string;
    readonly nextCursor?: string;
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

  /** A note on lines of one view's patch of the current session; lines that patch does not show are refused. */
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

  /** Resolve or Reopen one draft (#600). */
  setResolved(
    request: LocalDraftResolveRequest,
  ): Promise<Result<LocalDraftList, LocalDraftFailure>> {
    return this.locked(request, async (review) => {
      const now = this.dependencies.now();
      return openReviewChange(
        setLocalDraftResolved(
          review,
          request.draft,
          request.resolved ? now : undefined,
          now,
        ),
      );
    });
  }

  /**
   * The coding agent's reply to one draft (ADR 0052 `reply_to_note`),
   * replacing its earlier one. Text that looks like a credential is refused
   * before the Review lock, as for an agent intent.
   */
  reply(
    request: LocalDraftReplyRequest,
  ): Promise<Result<LocalDraftReplied, LocalDraftReplyFailure>> {
    const draft = parseLocalDraftId(request.draftId);
    if (draft === undefined)
      return Promise.resolve(err({ reason: "draft_not_found" }));
    const text = parseLocalDraftReplyText(request.text);
    if (text._tag === "err")
      return Promise.resolve(err({ reason: "invalid_input" }));
    if (containsSensitiveData(text.value))
      return Promise.resolve(err({ reason: "reply_sensitive" }));
    return this.withReviewLock<LocalDraftReplied, LocalDraftReplyFailure>(
      request,
      async (review) => {
        if (!isLocalReview(review)) return err({ reason: "not_applicable" });
        const repliedAt = this.dependencies.now();
        const replied = replyToLocalDraft(review, {
          draft,
          status: request.status,
          text: text.value,
          repliedAt,
        });
        if (replied._tag === "err")
          return err({
            reason:
              replied.error._tag === "DraftNotFound"
                ? "draft_not_found"
                : "terminal",
          });
        const saved = await this.dependencies.reviews.save(
          replied.value,
          review.updatedAt,
        );
        if (saved._tag === "err") return err({ reason: "storage" });
        const draftId = localDraftTargetId(draft);
        return ok({
          draftId,
          status: request.status,
          repliedAt,
          resolved: (review.localDrafts ?? []).some(
            (entry) =>
              localDraftId(entry) === draftId && entry.resolvedAt !== undefined,
          ),
        });
      },
    );
  }

  /** Ready for agent: stamps the Feedback hand-off, replacing an earlier one (ADR 0052). */
  handOff(
    request: FeedbackHandoffRequest,
  ): Promise<Result<LocalDraftList, LocalDraftFailure>> {
    return this.locked(request, async (review) =>
      openReviewChange(
        recordFeedbackHandoff(review, {
          at: this.dependencies.now(),
          ...definedProps({ verdict: request.verdict }),
        }),
      ),
    );
  }

  /**
   * One page of the Local drafts as the workbench lists them, each with its
   * carry state, and the prompt Copy as agent prompt renders for that page
   * (ADR 0052 `get_feedback`). A read, so it takes no lock.
   */
  async feedback(
    profileId: WorkspaceProfileId,
    reviewId: ReviewId,
    page: {
      readonly cursor?: string;
      /** Leaves out the drafts the maintainer resolved (#600). */
      readonly open?: boolean;
    } = {},
  ): Promise<
    Result<LocalFeedback, LocalDraftReadFailure | LocalFeedbackPageFailure>
  > {
    const review = await this.loadLocal(profileId, reviewId);
    if (review._tag === "err") return review;
    const current = await describeCurrentSession(
      this.dependencies.sessions,
      review.value,
    );
    if (current._tag === "err") return err({ reason: "storage" });
    const drafts = (review.value.localDrafts ?? []).filter(
      (draft) => page.open !== true || draft.resolvedAt === undefined,
    );
    const replies = review.value.localDraftReplies ?? [];
    const inline = await inlineInOriginView(current.value, drafts);
    const paged = pageLocalDrafts(drafts, page.cursor, (listed, prompted) => ({
      ...current.value.description,
      ...readFeedbackHandoff(review.value.handoff),
      localDrafts: listed.map((draft) =>
        projectFeedbackEntry(draft, inline, replies),
      ),
      markdown: renderLocalDraftsAsAgentPrompt(prompted),
    }));
    if (paged._tag === "err") return paged;
    return ok({
      ...paged.value.page,
      ...definedProps({ nextCursor: paged.value.nextCursor }),
    });
  }

  /**
   * The Local drafts as one prompt for the coding agent. Copying it is a
   * hand-off, so it stamps one without a verdict on an open Review; the
   * prompt carries no verdict (#603).
   */
  agentPrompt(
    profileId: WorkspaceProfileId,
    reviewId: ReviewId,
  ): Promise<
    Result<
      {
        readonly markdown: string;
        readonly feedbackHandoff?: FeedbackHandoffReading;
      },
      LocalDraftFailure
    >
  > {
    return this.withReviewLock({ profileId, reviewId }, async (review) => {
      if (!isLocalReview(review)) return err({ reason: "not_applicable" });
      const markdown = renderLocalDraftsAsAgentPrompt(review.localDrafts ?? []);
      const handedOff = recordFeedbackHandoff(review, {
        at: this.dependencies.now(),
      });
      if (handedOff._tag === "err") return ok({ markdown });
      const saved = await this.dependencies.reviews.save(
        handedOff.value,
        review.updatedAt,
      );
      if (saved._tag === "err") return err({ reason: "storage" });
      return ok({
        markdown,
        ...definedProps({
          feedbackHandoff: readFeedbackHandoff(handedOff.value.handoff),
        }),
      });
    });
  }

  private async loadLocal(
    profileId: WorkspaceProfileId,
    reviewId: ReviewId,
  ): Promise<Result<Review<LocalReviewSource>, LocalDraftReadFailure>> {
    const loaded = await this.dependencies.reviews.load(profileId, reviewId);
    if (loaded._tag === "err")
      return err({
        reason: loaded.error.reason === "not_found" ? "not_found" : "storage",
      });
    return isLocalReview(loaded.value)
      ? ok(loaded.value)
      : err({ reason: "not_applicable" });
  }

  private async locked(
    request: ReviewKey,
    change: (
      review: Review<LocalReviewSource>,
    ) => Promise<Result<Review<LocalReviewSource>, LocalDraftFailure>>,
  ): Promise<Result<LocalDraftList, LocalDraftFailure>> {
    return this.withReviewLock(request, async (review) => {
      if (
        !isLocalReview(review) ||
        review.currentSessionId !== request.sessionId
      )
        return err({ reason: "not_applicable" });
      const changed = await change(review);
      if (changed._tag === "err") return changed;
      const next = changed.value;
      // The store would refuse the whole Review; naming the reason lets the maintainer edit the secret out (#487).
      if (next !== review && containsSensitiveData(next.localDrafts))
        return err({ reason: "draft_sensitive" });
      if (next !== review) {
        const saved = await this.dependencies.reviews.save(
          next,
          review.updatedAt,
        );
        if (saved._tag === "err") return err({ reason: "storage" });
      }
      return ok({
        localDrafts: (next.localDrafts ?? []).map(projectLocalDraft),
        localDraftReplies: next.localDraftReplies ?? [],
        ...definedProps({ feedbackHandoff: readFeedbackHandoff(next.handoff) }),
      });
    });
  }

  /** Runs `write` on the Review it loaded while holding the Review lock. */
  private async withReviewLock<
    T,
    Failure extends LocalDraftFailure = LocalDraftFailure,
  >(
    request: {
      readonly profileId: WorkspaceProfileId;
      readonly reviewId: ReviewId;
    },
    write: (review: Review) => Promise<Result<T, NoInfer<Failure>>>,
  ): Promise<Result<T, Failure | LocalDraftLockFailure>> {
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
      return await write(loaded.value);
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
    if (isPullRequestReviewSession(session.value))
      return err({ reason: "not_applicable" });
    // Only a shared Review's session stores Committed and Uncommitted (#556).
    const patchPath =
      request.view === "combined"
        ? session.value.patchPath
        : session.value.viewPatches?.[request.view].patchPath;
    if (patchPath === undefined) return err({ reason: "not_applicable" });
    const patch = await readFile(patchPath, "utf8").catch(() => undefined);
    if (patch === undefined) return err({ reason: "storage" });
    const anchor = fingerprintPatchAnchor(patch, request.anchor);
    if (anchor === undefined) return err({ reason: "not_applicable" });
    const now = this.dependencies.now();
    return ok({
      author: "maintainer",
      noteId: this.dependencies.createNoteId(),
      sessionId: session.value.id,
      ...definedProps({
        view: request.view === "combined" ? undefined : request.view,
      }),
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
    // Only a replacement that still resolves in this patch, and that a fence line cannot break out of, travels with the draft.
    const suggestion =
      code !== undefined &&
      isAcceptableSuggestionCode(code) &&
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

/**
 * Whether a draft's lines sit inside a hunk of its origin view on the
 * Review's current session (#558): `placeInView`, the workbench's placement,
 * asked of that view's stored patch. A draft of an earlier session, or one
 * whose view patch cannot be read, is not inline. Only the views the current
 * session's drafts were written in are read.
 */
async function inlineInOriginView(
  current: CurrentSession,
  drafts: ReadonlyArray<LocalDraft>,
): Promise<(entry: LocalDraftEntry) => boolean> {
  const { session } = current;
  const viewPatches = isPullRequestReviewSession(session)
    ? undefined
    : session.viewPatches;
  const views = new Set<LocalPatchView>();
  for (const draft of drafts)
    if (draft.sessionId === session.id) views.add(draft.view ?? "combined");
  const hunks = new Map(
    await Promise.all(
      [...views].map(async (view) => {
        const patch =
          view === "combined"
            ? current.patch
            : await readViewPatch(viewPatches?.[view]);
        return [
          view,
          patch === undefined ? undefined : indexPatchHunks(patch),
        ] as const;
      }),
    ),
  );
  // A session without views holds Combined drafts only, and a draft placed in its own view never reads another view's paths.
  const paths: LocalPatchViewPaths = {
    combined: viewPatches?.combined.paths ?? [],
    committed: viewPatches?.committed.paths ?? [],
    uncommitted: viewPatches?.uncommitted.paths ?? [],
  };
  return (entry) => {
    const shownHunks = hunks.get(entry.view);
    return (
      entry.sessionId === session.id &&
      shownHunks !== undefined &&
      placeInView(entry, entry.view, { paths, shownHunks }).placement ===
        "inline"
    );
  };
}

function readViewPatch(
  stored: LocalSessionViewPatch | undefined,
): Promise<string | undefined> {
  return stored === undefined
    ? Promise.resolve(undefined)
    : readFile(stored.patchPath, "utf8").catch(() => undefined);
}

function projectFeedbackEntry(
  draft: LocalDraft,
  inline: (entry: LocalDraftEntry) => boolean,
  replies: ReadonlyArray<LocalDraftReply>,
): LocalFeedbackEntry {
  const projected = projectLocalDraft(draft);
  const { resolvedAt: _resolvedAt, ...listed } = projected;
  const draftId = localDraftId(draft);
  const reply = replies.find(
    (candidate) => localDraftTargetId(candidate.draft) === draftId,
  );
  const entry = {
    ...listed,
    draftId,
    state: localDraftFeedbackState(draft),
    inline: inline(projected),
    resolved: draft.resolvedAt !== undefined,
    ...definedProps({
      reply:
        reply === undefined
          ? undefined
          : {
              status: reply.status,
              text: reply.text,
              repliedAt: reply.repliedAt,
            },
    }),
  };
  if (isMaintainerNote(draft)) return entry;
  return {
    ...entry,
    comment: draft.comment,
    ...definedProps({ suggestion: draft.suggestion?.code }),
  };
}

/** A Local draft change the Review domain refused, as the failure the route answers with. */
function openReviewChange(
  changed: Result<
    Review<LocalReviewSource>,
    { readonly _tag: "ReviewTerminal" | "NoteNotFound" | "DraftNotFound" }
  >,
): Result<Review<LocalReviewSource>, LocalDraftFailure> {
  if (changed._tag === "ok") return changed;
  const reasons = {
    ReviewTerminal: "terminal",
    NoteNotFound: "not_found",
    DraftNotFound: "draft_not_found",
  } as const;
  return err({ reason: reasons[changed.error._tag] });
}
