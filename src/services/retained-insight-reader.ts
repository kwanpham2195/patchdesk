import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import * as v from "valibot";

import type { InsightStore } from "../adapters/storage/insight-store";
import type { ReviewSessionStore } from "../adapters/storage/review-session-store";
import { definedProps } from "../domain/defined-props";
import { createReviewId, type WorkspaceProfileId } from "../domain/ids";
import type {
  InsightArtifactStatus,
  InsightScopeProjection,
} from "../domain/insight";
import type { InsightRecord, RetainedInsight } from "../domain/insight-record";
import {
  normalizeNarrativeWalkthrough,
  type NarrativeWalkthrough,
} from "../domain/narrative-walkthrough";
import { parseUnifiedPatch } from "../domain/patch";
import { err, ok, type Result } from "../domain/result";
import { parseReviewResult, type ReviewResult } from "../domain/review-result";
import type { ReviewSession } from "../domain/review-session";
import { readObjectField } from "./read-object-field";
import type { WorkbenchProjectionFailure } from "./review-workbench-projection";

type StoredInsightRecords = {
  readonly analysis?: InsightRecord<RetainedInsight<ReviewResult>>;
  readonly walkthrough?: InsightRecord<RetainedInsight<NarrativeWalkthrough>>;
  readonly analysisScope?: InsightScopeProjection;
  readonly analysisArtifactStatus?: InsightArtifactStatus;
  readonly walkthroughArtifactStatus?: InsightArtifactStatus;
};

/**
 * Reads the Insight records the workbench projection retains for one Session,
 * including the artifact verification each retained value depends on.
 */
export class RetainedInsightReader {
  constructor(
    private readonly sessions: Pick<ReviewSessionStore, "load">,
    private readonly insights: Pick<InsightStore, "loadTyped">,
  ) {}

  async loadStoredInsights(
    session: ReviewSession,
  ): Promise<Result<StoredInsightRecords, WorkbenchProjectionFailure>> {
    // A retained Walkthrough belongs to the Session that produced it. Never
    // validate it against the currently represented Session's patch: Refresh
    // intentionally changes that artifact while old reading evidence remains.
    const [analysis, walkthrough] = await Promise.all([
      this.insights.loadTyped(
        session.key.profileId,
        createReviewId(session.key),
        "analysis",
        // The callback's parameter is left uninferred here (rather than
        // annotated `unknown`) so it takes its type from `loadTyped`'s
        // signature; this is the actual I/O boundary where a stored
        // Insight's `retained` value first becomes available to parse. The
        // envelope around it is already parsed -- see `parseRetainedInsight`.
        (input) => parseReviewResult(input),
      ),
      this.loadWalkthroughRecord(session),
    ]);
    // A corrupt or schema-drifted Insight record is ignored: the Review still
    // opens and the Insight reads as not generated, so a re-run heals it.
    if (
      analysis._tag === "err" &&
      analysis.error.reason !== "not_found" &&
      analysis.error.reason !== "invalid_stored_value"
    )
      return err({ _tag: "SessionStorageUnavailable" });
    if (
      walkthrough._tag === "err" &&
      walkthrough.error.reason !== "not_found" &&
      walkthrough.error.reason !== "invalid_stored_value"
    )
      return err({ _tag: "SessionStorageUnavailable" });
    const analysisArtifact =
      analysis._tag === "ok" && analysis.value.retained !== undefined
        ? await this.readInsightScope(
            session.key.profileId,
            analysis.value.retained,
          )
        : undefined;
    const records: StoredInsightRecords = definedProps({
      analysis: analysis._tag === "ok" ? analysis.value : undefined,
      walkthrough:
        walkthrough._tag === "ok" ? walkthrough.value.record : undefined,
      analysisScope: analysisArtifact?.scope,
      analysisArtifactStatus: analysisArtifact?.artifactStatus,
      walkthroughArtifactStatus:
        walkthrough._tag === "ok"
          ? walkthrough.value.artifactStatus
          : undefined,
    });
    return ok(records);
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
    const patch = await readFile(retainedSession.value.patchPath, "utf8").catch(
      () => undefined,
    );
    if (patch === undefined) return { artifactStatus: "mismatch" };
    const actualHash = createHash("sha256").update(patch).digest("hex");
    if (actualHash !== retained.revision.patchHash)
      return { artifactStatus: "mismatch" };
    const files = parseUnifiedPatch(patch);
    return {
      artifactStatus: "verified",
      scope: {
        baseShort: (retainedSession.value.pr.baseSha ?? "unknown").slice(0, 7),
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

  private async loadWalkthroughRecord(session: ReviewSession): Promise<
    Result<
      {
        readonly record: InsightRecord<RetainedInsight<NarrativeWalkthrough>>;
        readonly artifactStatus?: InsightArtifactStatus;
      },
      {
        readonly reason: "not_found" | "invalid_stored_value" | "storage";
      }
    >
  > {
    const loaded = await this.insights.loadTyped(
      session.key.profileId,
      createReviewId(session.key),
      "walkthrough",
      // The stored Walkthrough is normalized against its own session's patch
      // below, which needs the patch bytes this parser cannot read, so the
      // value is carried through unparsed and normalized after the envelope.
      (input) => ok(input),
    );
    if (loaded._tag === "err") {
      if (loaded.error.reason === "not_found")
        return err({ reason: "not_found" });
      if (loaded.error.reason === "invalid_stored_value")
        return err({ reason: "invalid_stored_value" });
      return err({ reason: "storage" });
    }
    const base = loaded.value.retained;
    if (base === undefined) {
      // SAFETY: `loaded.value.retained` is undefined here, so the generic
      // `RetainedInsight<NarrativeWalkthrough>` parameter names no runtime
      // data this branch actually inspects; only the `retained?` field's
      // absence, which is what the check above already confirmed, matters.
      return ok({
        record: loaded.value as InsightRecord<
          RetainedInsight<NarrativeWalkthrough>
        >,
      });
    }
    const rawValue = base.value;
    // Readable-without-artifact fallback: preserves bounded prose while
    // dropping hunk coordinates that no longer have trusted patch bytes to
    // resolve against. Each stored field degrades independently instead of
    // rejecting the whole record, matching the original hand-walked reader.
    const fallback = (): Result<
      {
        readonly record: InsightRecord<RetainedInsight<NarrativeWalkthrough>>;
        readonly artifactStatus: InsightArtifactStatus;
      },
      {
        readonly reason: "not_found" | "invalid_stored_value" | "storage";
      }
    > => {
      const rawChapters = readObjectField(rawValue, "chapters");
      const chapters = Array.isArray(rawChapters)
        ? rawChapters.slice(0, 12).map((chapter, chapterIndex) => {
            const rawSections = readObjectField(chapter, "sections");
            const sections = Array.isArray(rawSections)
              ? rawSections.slice(0, 32).map((section, sectionIndex) => ({
                  id: `section-${chapterIndex + 1}-${sectionIndex + 1}`,
                  title: v.parse(
                    boundedTextSchema(160, "Untitled section"),
                    readObjectField(section, "title"),
                  ),
                  prose: v.parse(
                    boundedTextSchema(
                      4_000,
                      "Stored section text is unavailable.",
                    ),
                    readObjectField(section, "prose"),
                  ),
                  hunkIds: [],
                  hunks: [],
                }))
              : [];
            return {
              id: `chapter-${chapterIndex + 1}`,
              title: v.parse(
                boundedTextSchema(80, "Untitled chapter"),
                readObjectField(chapter, "title"),
              ),
              sections,
            };
          })
        : [];
      const value: NarrativeWalkthrough = {
        snapshot: { profileId: session.key.profileId, ...base.revision },
        citationStatus: "unverified",
        title: v.parse(
          boundedTextSchema(200, "Stored Walkthrough"),
          readObjectField(rawValue, "title"),
        ),
        focus: v.parse(
          boundedTextSchema(2_000, "Stored source evidence is unavailable."),
          readObjectField(rawValue, "focus"),
        ),
        chapters,
        support: { id: "support", title: "Support", hunkIds: [], hunks: [] },
      };
      return ok({
        record: { ...loaded.value, retained: { ...base, value } },
        artifactStatus: "mismatch",
      });
    };
    const retainedSession = await this.sessions.load(
      session.key.profileId,
      base.revision.sessionId,
    );
    if (retainedSession._tag === "err") return fallback();
    const retainedPatch = await readFile(
      retainedSession.value.patchPath,
      "utf8",
    ).catch(() => undefined);
    if (retainedPatch === undefined) return fallback();
    const actualHash = createHash("sha256").update(retainedPatch).digest("hex");
    if (actualHash !== base.revision.patchHash) return fallback();
    const normalized = normalizeNarrativeWalkthrough(rawValue, retainedPatch, {
      profileId: session.key.profileId,
      sessionId: base.revision.sessionId,
      headSha: base.revision.headSha,
      patchHash: base.revision.patchHash,
    });
    if (normalized._tag === "err") return err({ reason: "storage" });
    return ok({
      record: {
        ...loaded.value,
        retained: { ...base, value: normalized.value },
      },
      artifactStatus: "verified",
    });
  }
}

/**
 * A bounded-text field that never fails: a non-blank string is truncated to
 * `maxLength` (its original, untrimmed bytes — matching the prior
 * `value.slice(0, maxLength)` behavior exactly), anything else falls back.
 */
function boundedTextSchema(maxLength: number, fallback: string) {
  return v.pipe(
    v.unknown(),
    v.transform((value) => {
      const parsed = v.safeParse(v.string(), value);
      return parsed.success && parsed.output.trim().length > 0
        ? parsed.output.slice(0, maxLength)
        : fallback;
    }),
  );
}
