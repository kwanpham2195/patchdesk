import type { PatchdeskPaths } from "#src/adapters/storage/patchdesk-paths";
import { definedProps } from "#src/domain/defined-props";
import { insightEvidenceFailureCategory } from "#src/domain/insight-failure-diagnostic";
import type {
  InsightEvidenceBundle,
  InsightEvidenceIdentity,
} from "#src/domain/insight-evidence";
import type { InsightLanguage } from "#src/domain/insight-provider";
import type { ReviewSession } from "#src/domain/review-session";
import { err, ok, type Result } from "#src/domain/result";
import {
  captureGuideEvidence,
  composeGuidePrompt,
  type PreparedGuide,
} from "./guide-operation";
import { insightEvidenceReference } from "./insight-evidence-reference";
import { InsightEvidenceService } from "./insight-evidence-service";
import type { WorkspaceProfileId, InsightRunId } from "#src/domain/ids";
import type {
  InsightType,
  InsightFailureCategory,
} from "#src/domain/insight-record";
import type { ReviewDiagnosticService } from "./review-diagnostic-service";
import type {
  PackChangeIntent,
  ReviewContextPackService,
} from "./review-context-pack-service";
import { hashReviewArtifactContent } from "./review-artifact-hash";

/** Prepares run-owned provider evidence without mutating Insight lifecycle state. */
export class InsightRunPreparation {
  constructor(
    private readonly paths: PatchdeskPaths,
    private readonly contextPack: ReviewContextPackService,
    private readonly diagnostics?: Pick<ReviewDiagnosticService, "record">,
  ) {}

  /** Records coordinator pre-ack time independently of deferred preparation. */
  async recordAdmission(
    input: {
      readonly profileId: WorkspaceProfileId;
      readonly type: InsightType;
    },
    durationMs: number,
    runId: InsightRunId | undefined,
  ): Promise<void> {
    try {
      await this.diagnostics?.record({
        profileId: input.profileId,
        category: "preparation",
        phase: `insight-${input.type}-pre-ack`,
        retryable: false,
        durationMs,
        ...definedProps({ incidentId: runId }),
      });
    } catch {
      // Diagnostics never delay acknowledgment or change its result.
    }
  }

  /** Builds a queued run's pack from admitted intent, under the Review lock. */
  async prepareRun(input: {
    readonly identity: InsightEvidenceIdentity;
    readonly session: ReviewSession;
    readonly language: InsightLanguage;
    readonly changeIntent: Extract<
      PackChangeIntent,
      { readonly _tag: "Captured" | "Unread" }
    >;
    readonly signal: AbortSignal;
  }): Promise<
    Result<
      {
        readonly evidence: InsightEvidenceBundle;
        readonly guide?: PreparedGuide;
      },
      InsightFailureCategory | "cancelled"
    >
  > {
    if (input.signal.aborted) return err("cancelled");
    const began = performance.now();
    const pack = await this.contextPack.ensure({
      session: input.session,
      patchHash: input.identity.patchHash,
      changeIntent: input.changeIntent,
    });
    await this.record(
      input.identity,
      "context-ensure",
      performance.now() - began,
    );
    if (input.signal.aborted) return err("cancelled");
    if (pack._tag === "err") return err("evidence_unavailable");
    const prepared = await this.prepare(input);
    if (input.signal.aborted) return err("cancelled");
    return prepared._tag === "ok"
      ? prepared
      : err(
          prepared.error === "stale_request"
            ? "evidence_mismatch"
            : prepared.error,
        );
  }

  /** The caller holds the Review lock and has ensured its context pack. */
  async prepare(input: {
    readonly identity: InsightEvidenceIdentity;
    readonly session: ReviewSession;
    readonly language: InsightLanguage;
  }): Promise<
    Result<
      {
        readonly evidence: InsightEvidenceBundle;
        readonly guide?: PreparedGuide;
      },
      | "guide_patch_empty"
      | "guide_artifact_unreadable"
      | "guide_input_too_large"
      | "stale_request"
      | "evidence_unavailable"
      | "evidence_mismatch"
    >
  > {
    const guide =
      input.identity.type === "guide"
        ? await captureGuideEvidence({
            contextPath: this.paths.preparedContextFile(
              input.identity.profileId,
              input.session.id,
            ),
            patchPath: input.session.patchPath,
            language: input.language,
          })
        : undefined;
    if (guide?._tag === "err")
      return err(
        guide.error.reason === "patch_not_indexable"
          ? "guide_patch_empty"
          : guide.error.reason === "artifact_unreadable"
            ? "guide_artifact_unreadable"
            : "guide_input_too_large",
      );
    if (
      guide?._tag === "ok" &&
      hashReviewArtifactContent(guide.value.patchText) !==
        input.identity.patchHash
    )
      return err("stale_request");
    const evidence = await new InsightEvidenceService(this.paths).prepare({
      identity: input.identity,
      patchPath: input.session.patchPath,
      observe: (phase, durationMs, counts) =>
        this.record(input.identity, phase, durationMs, counts),
      snapshots: (context) =>
        this.contextPack.captureChangedHeadFiles(input.session, context),
    });
    if (evidence._tag === "err")
      return err(insightEvidenceFailureCategory(evidence.error.reason));
    return ok({
      evidence: evidence.value,
      ...definedProps({
        guide:
          guide?._tag === "ok"
            ? {
                ...guide.value,
                prompt: composeGuidePrompt(
                  insightEvidenceReference(evidence.value),
                  input.language,
                ),
              }
            : undefined,
      }),
    });
  }
  private async record(
    identity: InsightEvidenceIdentity,
    phase: string,
    durationMs: number,
    counts?: { readonly sources: number; readonly pages: number },
  ): Promise<void> {
    try {
      await this.diagnostics?.record({
        profileId: identity.profileId,
        sessionId: identity.sessionId,
        incidentId: identity.runId,
        category: "preparation",
        phase: `insight-${identity.type}-${phase}`,
        retryable: false,
        durationMs: Math.round(durationMs),
        ...definedProps({
          detail:
            counts === undefined
              ? undefined
              : `sources=${counts.sources}; pages=${counts.pages}`,
        }),
      });
    } catch {
      // A diagnostic failure cannot change preparation or provider admission.
    }
  }
}
