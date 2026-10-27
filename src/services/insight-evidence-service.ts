import { readFile } from "node:fs/promises";

import { InsightEvidenceStore } from "#src/adapters/storage/insight-evidence-store";
import { evidencePathIsOwned } from "#src/adapters/storage/insight-evidence-validation";
import type { PatchdeskPaths } from "#src/adapters/storage/patchdesk-paths";
import type {
  InsightEvidenceBundle,
  InsightEvidenceFailure,
  InsightEvidenceIdentity,
} from "#src/domain/insight-evidence";
import { err, ok, type Result } from "#src/domain/result";
import { buildInsightEvidenceTree } from "./insight-evidence-tree-builder";
import { hashReviewArtifactContent } from "./review-artifact-hash";
import { readBoundedArtifact } from "./walkthrough-artifact-reader";

/** Captures only the context allowed for one Insight, before providers start. */
export class InsightEvidenceService {
  private readonly store: InsightEvidenceStore;
  constructor(private readonly paths: PatchdeskPaths) {
    this.store = new InsightEvidenceStore(paths);
  }

  /** Call under the Review lock after context-pack ensure; never rebuild a published run. */
  async prepare(input: {
    readonly identity: InsightEvidenceIdentity;
    readonly patchPath: string;
    readonly observe?: (
      phase: "evidence-build" | "evidence-publish",
      durationMs: number,
      counts: { readonly sources: number },
    ) => Promise<void>;
    readonly snapshots: (
      context: string,
      onSkipped: (path: string, reason: string) => void,
    ) => Promise<Readonly<Record<string, string>>>;
  }): Promise<Result<InsightEvidenceBundle, InsightEvidenceFailure>> {
    const identity = input.identity;
    const contextPath = this.paths.preparedContextFile(
      identity.profileId,
      identity.sessionId,
    );
    const reviewInputPath = this.paths.preparedReviewInputFile(
      identity.profileId,
      identity.sessionId,
    );
    const requiredPaths = [
      input.patchPath,
      ...(identity.type === "brief" ? [] : [contextPath]),
      ...(identity.type === "analysis" ? [reviewInputPath] : []),
    ];
    if (
      input.patchPath !==
      this.paths.patchFile(identity.profileId, identity.sessionId)
    )
      return err({
        _tag: "InsightEvidenceFailure",
        reason: "evidence_mismatch",
      });
    for (const path of requiredPaths)
      if (!(await evidencePathIsOwned(this.paths.dataDirectory(), path)))
        return err({
          _tag: "InsightEvidenceFailure",
          reason: "evidence_mismatch",
        });
    try {
      const began = performance.now();
      const patchRead =
        identity.type === "analysis" || identity.type === "guide"
          ? ok(await readFile(input.patchPath, "utf8"))
          : await readBoundedArtifact(
              input.patchPath,
              (identity.type === "brief" ? 64 : 2) * 1024 * 1024,
            );
      if (patchRead._tag === "err")
        return err({
          _tag: "InsightEvidenceFailure",
          reason: "evidence_unavailable",
        });
      const patch = patchRead.value;
      if (hashReviewArtifactContent(patch) !== identity.patchHash)
        return err({
          _tag: "InsightEvidenceFailure",
          reason: "evidence_mismatch",
        });
      const contextRead =
        identity.type === "brief"
          ? ok("")
          : identity.type === "analysis"
            ? ok(await readFile(contextPath, "utf8"))
            : await readBoundedArtifact(contextPath, 512 * 1024);
      if (contextRead._tag === "err")
        return err({
          _tag: "InsightEvidenceFailure",
          reason: "evidence_unavailable",
        });
      const reviewInput =
        identity.type === "analysis"
          ? await readFile(reviewInputPath, "utf8")
          : "";
      const snapshotSkips: Record<string, string> = Object.create(null);
      const snapshots =
        identity.type === "analysis"
          ? await input.snapshots(contextRead.value, (path, reason) => {
              snapshotSkips[path] = reason;
            })
          : {};
      const bundle = buildInsightEvidenceTree({
        snapshotSkips,
        identity,
        patch,
        context: contextRead.value,
        reviewInput,
        snapshots,
        directory: this.paths.analysisEvidenceDirectory(
          identity.profileId,
          identity.sessionId,
          identity.runId,
        ),
      });
      if (bundle._tag === "err") return bundle;
      const counts = {
        sources: bundle.value.sources.length,
      };
      await input.observe?.(
        "evidence-build",
        performance.now() - began,
        counts,
      );
      const publishBegan = performance.now();
      const published = await this.store.publish(bundle.value);
      await input.observe?.(
        "evidence-publish",
        performance.now() - publishBegan,
        counts,
      );
      return published._tag === "err" ? published : bundle;
    } catch {
      return err({
        _tag: "InsightEvidenceFailure",
        reason: "evidence_unavailable",
      });
    }
  }
}
