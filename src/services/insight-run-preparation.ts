import type { PatchdeskPaths } from "#src/adapters/storage/patchdesk-paths";
import { definedProps } from "#src/domain/defined-props";
import type {
  InsightEvidenceBundle,
  InsightEvidenceIdentity,
} from "#src/domain/insight-evidence";
import type { InsightLanguage } from "#src/domain/insight-provider";
import type { ReviewSession } from "#src/domain/review-session";
import { err, ok, type Result } from "#src/domain/result";
import { prepareGuidePrompt, type PreparedGuide } from "./guide-operation";
import { InsightEvidenceService } from "./insight-evidence-service";
import type { ReviewContextPackService } from "./review-context-pack-service";
import { hashReviewArtifactContent } from "./review-artifact-hash";

/** Prepares run-owned provider evidence without mutating Insight lifecycle state. */
export class InsightRunPreparation {
  constructor(
    private readonly paths: PatchdeskPaths,
    private readonly contextPack: ReviewContextPackService,
  ) {}

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
      | "storage_unavailable"
    >
  > {
    const guide =
      input.identity.type === "guide"
        ? await prepareGuidePrompt({
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
      snapshots: (context) =>
        this.contextPack.captureChangedHeadFiles(input.session, context),
    });
    if (evidence._tag === "err") return err("storage_unavailable");
    return ok({
      evidence: evidence.value,
      ...definedProps({
        guide: guide?._tag === "ok" ? guide.value : undefined,
      }),
    });
  }
}
