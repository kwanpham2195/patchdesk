import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import type { ReviewSessionStore } from "../adapters/storage/review-session-store";
import type { ReviewStore } from "../adapters/storage/review-store";
import type { InsightStore } from "../adapters/storage/insight-store";
import type { ReviewRemoteSnapshot, ReviewRemoteStore } from "../adapters/storage/review-remote-store";
import { createReview, markReviewTerminal, type Review } from "../domain/review";
import type { ReviewSession } from "../domain/review-session";
import { createReviewId, parseInsightRunId, type ContentHash, type InsightRunId, type WorkspaceProfileId } from "../domain/ids";
import { parseReviewResult } from "../domain/review-result";
import { normalizeNarrativeWalkthrough } from "../domain/narrative-walkthrough";
import type { WalkthroughProgress } from "../domain/insight-record";
import { err, ok, type Result } from "../domain/result";
import type { StorageFailure } from "../adapters/storage/json-file";
import { readJsonFile, writeAtomicJson } from "../adapters/storage/json-file";
import type { PatchdeskPaths } from "../adapters/storage/patchdesk-paths";

export type UnifiedReviewMigrationResult = {
  readonly migrated: ReadonlyArray<Review>;
  readonly existing: ReadonlyArray<Review>;
  readonly skipped: number;
};

type MigrationMarker = {
  readonly schemaVersion: 1;
  readonly profileId: WorkspaceProfileId;
  readonly completedAt: string;
};

export type MigrationStage = "remote" | "review" | "analysis" | "walkthrough" | "marker";

export type UnifiedReviewMigrationOptions = {
  /** The marker is optional for in-memory callers; production always supplies paths. */
  readonly paths?: PatchdeskPaths;
  readonly now?: () => string;
  /** Existing durable owners used to retain legacy artifacts in their canonical locations. */
  readonly remote?: Pick<ReviewRemoteStore, "saveCandidate">;
  readonly insights?: Pick<InsightStore, "load" | "save">;
  /** Test hook used to model a process interruption between durable stages. */
  readonly afterReview?: (review: Review) => Promise<void>;
  readonly afterStage?: (stage: MigrationStage) => Promise<void>;
};

/**
 * Adopts legacy session-owned state into stable Review aggregates.
 *
 * Target artifacts are written and validated before the per-profile marker. A
 * rerun only fills missing targets; an existing valid target always wins.
 */
export class UnifiedReviewMigration {
  constructor(
    private readonly sessions: Pick<ReviewSessionStore, "listSessions"> & Partial<Pick<ReviewSessionStore, "scanSessionEntries">>,
    private readonly reviews: Pick<ReviewStore, "load" | "save">,
    private readonly options: UnifiedReviewMigrationOptions = {},
  ) {}

  async migrateProfile(profileId: WorkspaceProfileId): Promise<Result<UnifiedReviewMigrationResult, StorageFailure>> {
    const marker = await this.readMarker(profileId);
    if (marker._tag === "err") return marker;
    const markerCompleted = marker.value !== undefined;

    const scanned = this.sessions.scanSessionEntries === undefined
      ? undefined
      : await this.sessions.scanSessionEntries(profileId);
    if (scanned?._tag === "err") return scanned;
    const listed = scanned === undefined ? await this.sessions.listSessions(profileId) : ok(scanned.value.sessions);
    if (listed._tag === "err") return listed;
    const groups = new Map<string, ReviewSession[]>();
    for (const session of listed.value) {
      const key = [session.key.host, session.key.owner, session.key.repo, session.key.prNumber].join("\n");
      const group = groups.get(key) ?? [];
      group.push(session);
      groups.set(key, group);
    }
    const migrated: Review[] = [];
    const existing: Review[] = [];
    // listSessions intentionally omits quarantined/corrupt entries. They are
    // not adopted and remain available to the recovery/quarantine owner.
    const skipped = scanned?.value.invalidEntries.length ?? 0;
    for (const group of groups.values()) {
      const selected = selectSession(group);
      if (selected === undefined) continue;
      const identity = { profileId, host: selected.key.host, owner: selected.key.owner, repo: selected.key.repo, prNumber: selected.key.prNumber };
      const reviewId = createReviewId(identity);
      const created = createReview({ identity, currentSessionId: selected.id, headSha: selected.key.headSha, createdAt: selected.createdAt });
      const terminal = selected.state._tag === "Merged"
        ? markReviewTerminal(created, "merged", selected.updatedAt)
        : selected.pr?.isOpen === false
          ? markReviewTerminal(created, "closed", selected.updatedAt)
          : created;

      const loaded = await this.reviews.load(profileId, reviewId);
      if (loaded._tag === "ok") {
        if (loaded.value.identity.profileId !== profileId || loaded.value.id !== reviewId) return invalidStorage("read");
        existing.push(loaded.value);
        // Existing targets are authoritative. We still retain missing legacy
        // Insight records below, because those are independent durable owners.
        const insights = await this.migrateInsights(profileId, loaded.value, group);
        if (insights._tag === "err") return insights;
        continue;
      }
      if (loaded.error.reason !== "not_found") return loaded;

      const represented = await this.migrateRemote(profileId, reviewId, selected);
      if (represented._tag === "err") return represented;
      const candidate = represented.value === undefined
        ? terminal
        : { ...terminal, representedRemote: represented.value };
      const saved = await this.reviews.save(candidate);
      if (saved._tag === "err") return storageFailure(saved.error);
      if (this.options.afterStage !== undefined) await this.options.afterStage("review");
      if (this.options.afterReview !== undefined) await this.options.afterReview(candidate);
      const insights = await this.migrateInsights(profileId, candidate, group);
      if (insights._tag === "err") return insights;
      migrated.push(candidate);
    }
    if (!markerCompleted) {
      const written = await this.writeMarker(profileId);
      if (written._tag === "err") return written;
      if (this.options.afterStage !== undefined) await this.options.afterStage("marker");
    }
    return ok({ migrated, existing, skipped });
  }

  private async migrateRemote(
    profileId: WorkspaceProfileId,
    reviewId: ReturnType<typeof createReviewId>,
    session: ReviewSession,
  ): Promise<Result<Review["representedRemote"], StorageFailure>> {
    if (this.options.remote === undefined) return ok(undefined);
    const snapshot: ReviewRemoteSnapshot = {
      schemaVersion: 1,
      pullRequest: {
        headSha: session.pr?.headSha ?? session.key.headSha,
        ...(session.pr?.baseSha === undefined ? {} : { baseSha: session.pr.baseSha }),
        isDraft: session.pr?.isDraft ?? false,
        isOpen: session.pr?.isOpen ?? true,
        ref: { host: session.key.host, owner: session.key.owner, repo: session.key.repo, number: session.key.prNumber },
        title: session.prContext?.title ?? `${session.key.owner}/${session.key.repo}#${session.key.prNumber}`,
        ...(session.prContext?.description === undefined ? {} : { description: session.prContext.description }),
        author: session.prContext?.author ?? "unknown",
        headBranch: session.prContext?.headBranch ?? "unknown",
        baseBranch: session.prContext?.baseBranch ?? "unknown",
        reviewState: "unknown",
        mergeability: "unknown",
        labels: [],
        updatedAt: session.updatedAt,
      },
      comments: { threads: [], complete: false, incompleteReason: "unavailable" },
      commits: [],
      checks: { overall: "unknown", checks: [] },
    };
    const saved = await this.options.remote.saveCandidate({ profileId, reviewId, snapshot });
    if (saved._tag === "err") return saved;
    if (this.options.afterStage !== undefined) await this.options.afterStage("remote");
    return ok({ headSha: snapshot.pullRequest.headSha, pullRequestUpdatedAt: snapshot.pullRequest.updatedAt, snapshotHash: saved.value.snapshotHash, refreshedAt: session.updatedAt });
  }

  private async migrateInsights(
    profileId: WorkspaceProfileId,
    review: Review,
    sessions: ReadonlyArray<ReviewSession>,
  ): Promise<Result<void, StorageFailure>> {
    if (this.options.insights === undefined) return ok(undefined);
    const reviewId = review.id;
    // Legacy artifacts belong to sessions, while the new Insight owner belongs
    // to the Review. Inspect every session and choose the newest valid artifact
    // independently for each type. A malformed newest artifact must not hide a
    // valid retained result from an older revision.
    const candidates = [...sessions].sort((left, right) => {
      const updated = right.updatedAt.localeCompare(left.updatedAt);
      return updated !== 0 ? updated : right.id.localeCompare(left.id);
    });
    let analysis: InsightMigrationCandidate | undefined;
    let walkthrough: InsightMigrationCandidate | undefined;
    for (const session of candidates) {
      const patch = await readFile(session.patchPath, "utf8").catch(() => "");
      const patchHash = createHash("sha256").update(patch).digest("hex") as ContentHash;
      const legacy = session as unknown as LegacyInsightFields;
      if (analysis === undefined && session.visibleResult !== undefined) {
        const parsed = parseReviewResult(session.visibleResult);
        const runId = parseInsightRunId(legacy.analysisRunId ?? `insight-analysis-1-${reviewId.slice(-12)}-migration`);
        if (parsed._tag === "ok" && runId._tag === "ok") {
          analysis = { session, patchHash, runId: runId.value, value: parsed.value };
        }
      }
      if (walkthrough === undefined) {
        const raw = legacy.walkthrough ?? legacy.visibleWalkthrough;
        if (raw !== undefined) {
          const normalized = normalizeNarrativeWalkthrough(raw, patch, { profileId, sessionId: session.id, headSha: session.key.headSha, patchHash });
          const runId = parseInsightRunId(legacy.walkthroughRunId ?? `insight-walkthrough-1-${reviewId.slice(-12)}-migration`);
          if (normalized._tag === "ok" && runId._tag === "ok") {
            const progress = normalizeProgress(legacy.walkthroughProgress);
            walkthrough = { session, patchHash, runId: runId.value, value: normalized.value, ...(progress === undefined ? {} : { progress }) };
          }
        }
      }
      if (analysis !== undefined && walkthrough !== undefined) break;
    }

    const currentAnalysis = await this.options.insights.load(profileId, reviewId, "analysis");
    if (currentAnalysis._tag === "err" && currentAnalysis.error.reason !== "not_found") return currentAnalysis;
    if (analysis !== undefined && (currentAnalysis._tag === "err" || currentAnalysis.value.retained === undefined)) {
      const base = currentAnalysis._tag === "ok" ? currentAnalysis.value : { schemaVersion: 1 as const, reviewId, type: "analysis" as const, nextToken: 1, updatedAt: analysis.session.updatedAt };
      const saved = await this.options.insights.save(profileId, {
        ...base,
        retained: { runId: analysis.runId, revision: { sessionId: analysis.session.id, headSha: analysis.session.key.headSha, patchHash: analysis.patchHash }, generatedAt: analysis.session.updatedAt, value: analysis.value },
      });
      if (saved._tag === "err") return saved;
      if (this.options.afterStage !== undefined) await this.options.afterStage("analysis");
    }

    const currentWalkthrough = await this.options.insights.load(profileId, reviewId, "walkthrough");
    if (currentWalkthrough._tag === "err" && currentWalkthrough.error.reason !== "not_found") return currentWalkthrough;
    if (walkthrough !== undefined && (currentWalkthrough._tag === "err" || currentWalkthrough.value.retained === undefined)) {
      const base = currentWalkthrough._tag === "ok" ? currentWalkthrough.value : { schemaVersion: 1 as const, reviewId, type: "walkthrough" as const, nextToken: 1, updatedAt: walkthrough.session.updatedAt };
      const saved = await this.options.insights.save(profileId, {
        ...base,
        retained: { runId: walkthrough.runId, revision: { sessionId: walkthrough.session.id, headSha: walkthrough.session.key.headSha, patchHash: walkthrough.patchHash }, generatedAt: walkthrough.session.updatedAt, value: walkthrough.value },
        ...(walkthrough.progress === undefined ? {} : { walkthroughProgress: walkthrough.progress }),
      });
      if (saved._tag === "err") return saved;
      if (this.options.afterStage !== undefined) await this.options.afterStage("walkthrough");
    }
    return ok(undefined);
  }

  private async readMarker(profileId: WorkspaceProfileId): Promise<Result<MigrationMarker | undefined, StorageFailure>> {
    if (this.options.paths === undefined) return ok(undefined);
    const stored = await readJsonFile(this.options.paths.reviewMigrationMarkerFile(profileId));
    if (stored._tag === "err") return stored.error.reason === "not_found" ? ok(undefined) : stored;
    if (!isMigrationMarker(stored.value, profileId)) return invalidStorage("read");
    return ok(stored.value);
  }

  private async writeMarker(profileId: WorkspaceProfileId): Promise<Result<void, StorageFailure>> {
    if (this.options.paths === undefined) return ok(undefined);
    const marker: MigrationMarker = { schemaVersion: 1, profileId, completedAt: this.options.now?.() ?? new Date().toISOString() };
    return writeAtomicJson(this.options.paths.reviewMigrationMarkerFile(profileId), marker);
  }
}

type InsightMigrationCandidate = {
  readonly session: ReviewSession;
  readonly patchHash: ContentHash;
  readonly runId: InsightRunId;
  readonly value: unknown;
  readonly progress?: WalkthroughProgress;
};

type LegacyInsightFields = {
  readonly analysisRunId?: string;
  readonly walkthrough?: unknown;
  readonly visibleWalkthrough?: unknown;
  readonly walkthroughRunId?: string;
  readonly walkthroughProgress?: unknown;
};

function normalizeProgress(input: unknown): WalkthroughProgress | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const value = input as { reviewedSectionIds?: unknown; supportReviewed?: unknown; currentSectionId?: unknown };
  if (!Array.isArray(value.reviewedSectionIds) || !value.reviewedSectionIds.every((id) => typeof id === "string") || typeof value.supportReviewed !== "boolean") return undefined;
  return { reviewedSectionIds: [...new Set(value.reviewedSectionIds)], supportReviewed: value.supportReviewed, ...(typeof value.currentSectionId === "string" ? { currentSectionId: value.currentSectionId } : {}) };
}

function isMigrationMarker(value: unknown, profileId: WorkspaceProfileId): value is MigrationMarker {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { schemaVersion?: unknown; profileId?: unknown; completedAt?: unknown };
  return candidate.schemaVersion === 1 && candidate.profileId === profileId && typeof candidate.completedAt === "string" && !Number.isNaN(Date.parse(candidate.completedAt));
}

function storageFailure(failure: unknown): Result<never, StorageFailure> {
  return err(failure && typeof failure === "object" && "_tag" in failure && failure._tag === "StorageFailure" ? failure as StorageFailure : { _tag: "StorageFailure", operation: "write", reason: "io" });
}

function invalidStorage(operation: "read" | "write"): Result<never, StorageFailure> {
  return err({ _tag: "StorageFailure", operation, reason: "invalid_stored_value" });
}

function selectSession(sessions: ReadonlyArray<ReviewSession>): ReviewSession | undefined {
  return [...sessions].sort((left, right) => {
    const leftTerminal = left.state._tag === "Merged";
    const rightTerminal = right.state._tag === "Merged";
    if (leftTerminal !== rightTerminal) return leftTerminal ? -1 : 1;
    const updated = right.updatedAt.localeCompare(left.updatedAt);
    return updated !== 0 ? updated : right.id.localeCompare(left.id);
  })[0];
}
