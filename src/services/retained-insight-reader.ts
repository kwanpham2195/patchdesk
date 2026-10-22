import { parseRetainedGuide, type RetainedGuide } from "#src/domain/guide";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { InsightStore } from "#src/adapters/storage/insight-store";
import type { ReviewSessionStore } from "#src/adapters/storage/review-session-store";
import type { NormalizedBrief } from "#src/domain/brief";
import { definedProps } from "#src/domain/defined-props";
import { createReviewId, type WorkspaceProfileId } from "#src/domain/ids";
import type {
  InsightArtifactStatus,
  InsightScopeProjection,
} from "#src/domain/insight";
import type {
  InsightRecord,
  RetainedInsight,
} from "#src/domain/insight-record";
import { parseUnifiedPatch } from "#src/domain/patch";
import { err, ok, type Result } from "#src/domain/result";
import {
  parseReviewResult,
  type ReviewResult,
} from "#src/domain/review-result";
import type { ReviewSession } from "#src/domain/review-session";
import { parseStoredBrief } from "#src/domain/stored-brief";
import type { WorkbenchProjectionFailure } from "./review-workbench-projection";

type StoredInsightRecords = {
  readonly guide?: InsightRecord<RetainedInsight<RetainedGuide>>;
  readonly analysis?: InsightRecord<RetainedInsight<ReviewResult>>;
  readonly brief?: InsightRecord<RetainedInsight<NormalizedBrief>>;
  readonly analysisScope?: InsightScopeProjection;
  readonly analysisArtifactStatus?: InsightArtifactStatus;
  readonly briefArtifactStatus?: InsightArtifactStatus;
};

/** Reads non-paged retained records and verifies their captured artifacts. */
export class RetainedInsightReader {
  constructor(
    private readonly sessions: Pick<ReviewSessionStore, "load">,
    private readonly insights: Pick<InsightStore, "loadTyped">,
  ) {}

  async loadStoredInsights(
    session: ReviewSession,
  ): Promise<Result<StoredInsightRecords, WorkbenchProjectionFailure>> {
    const [analysis, guide, brief] = await Promise.all([
      this.insights.loadTyped(
        session.key.profileId,
        createReviewId(session.key),
        "analysis",
        (input) => parseReviewResult(input),
      ),
      this.insights.loadTyped(
        session.key.profileId,
        createReviewId(session.key),
        "guide",
        parseRetainedGuide,
      ),
      this.insights.loadTyped(
        session.key.profileId,
        createReviewId(session.key),
        "brief",
        (input) => parseStoredBrief(input),
      ),
    ]);
    // A malformed legacy record does not prevent opening the Review.
    for (const record of [analysis, guide, brief]) {
      if (
        record._tag === "err" &&
        record.error.reason !== "not_found" &&
        record.error.reason !== "invalid_stored_value"
      )
        return err({ _tag: "SessionStorageUnavailable" });
    }
    const analysisArtifact =
      analysis._tag === "ok" && analysis.value.retained !== undefined
        ? await this.readInsightScope(
            session.key.profileId,
            analysis.value.retained,
          )
        : undefined;
    const briefArtifactStatus =
      brief._tag === "ok" && brief.value.retained !== undefined
        ? await this.readArtifactStatus(
            session.key.profileId,
            brief.value.retained,
          )
        : undefined;
    return ok(
      definedProps({
        guide: guide._tag === "ok" ? guide.value : undefined,
        analysis: analysis._tag === "ok" ? analysis.value : undefined,
        brief: brief._tag === "ok" ? brief.value : undefined,
        briefArtifactStatus,
        analysisScope: analysisArtifact?.scope,
        analysisArtifactStatus: analysisArtifact?.artifactStatus,
      }),
    );
  }

  private async readInsightScope(
    profileId: WorkspaceProfileId,
    retained: RetainedInsight<ReviewResult>,
  ): Promise<{
    readonly scope?: InsightScopeProjection;
    readonly artifactStatus: InsightArtifactStatus;
  }> {
    const retainedSession = await this.sessions.load(
      profileId,
      retained.revision.sessionId,
    );
    if (retainedSession._tag === "err") return { artifactStatus: "mismatch" };
    const patch = await this.readVerifiedPatch(profileId, retained);
    if (patch === undefined) return { artifactStatus: "mismatch" };
    const files = parseUnifiedPatch(patch);
    return {
      artifactStatus: "verified",
      scope: {
        baseShort: (retainedSession.value.key.baseSha ?? "unknown").slice(0, 7),
        headShort: retained.revision.headSha.slice(0, 7),
        commitCount: 0,
        fileCount: files.length,
        additions: files.reduce((total, file) => total + file.additions, 0),
        deletions: files.reduce((total, file) => total + file.deletions, 0),
        changedFiles: files.map((file) => ({
          path: file.newPath,
          additions: file.additions,
          deletions: file.deletions,
        })),
      },
    };
  }

  /** Only the exact bytes named by the retained revision can establish citation coordinates. */
  private async readVerifiedPatch(
    profileId: WorkspaceProfileId,
    retained: RetainedInsight<unknown>,
  ): Promise<string | undefined> {
    const retainedSession = await this.sessions.load(
      profileId,
      retained.revision.sessionId,
    );
    if (retainedSession._tag === "err") return undefined;
    const patch = await readFile(retainedSession.value.patchPath, "utf8").catch(
      () => undefined,
    );
    if (patch === undefined) return undefined;
    return createHash("sha256").update(patch).digest("hex") ===
      retained.revision.patchHash
      ? patch
      : undefined;
  }

  private async readArtifactStatus(
    profileId: WorkspaceProfileId,
    retained: RetainedInsight<unknown>,
  ): Promise<InsightArtifactStatus> {
    return (await this.readVerifiedPatch(profileId, retained)) === undefined
      ? "mismatch"
      : "verified";
  }
}
