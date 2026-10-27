import { chmod, mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

import { mapConcurrent } from "#src/domain/map-concurrent";
import {
  type InsightEvidenceBundle,
  type InsightEvidenceFailure,
} from "#src/domain/insight-evidence";
import { err, type Result } from "#src/domain/result";
import { validateInsightEvidenceTree } from "./insight-evidence-tree-validation";
import { isPathContained } from "./path-containment";
import { writeAtomicFile } from "./json-file";
import { evidencePathIsOwned } from "./insight-evidence-validation";
import type { PatchdeskPaths } from "./patchdesk-paths";

/** Publishes run-owned bundles and reads only parent-indexed evidence. */
export class InsightEvidenceStore {
  constructor(private readonly paths: PatchdeskPaths) {}

  /** Interrupted temporary directories cannot be selected by a run descriptor. */
  async publish(
    bundle: InsightEvidenceBundle,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<Result<void, InsightEvidenceFailure>> {
    if (
      !this.owns(bundle) ||
      !(await evidencePathIsOwned(this.paths.dataDirectory(), bundle.directory))
    )
      return err({
        _tag: "InsightEvidenceFailure",
        reason: "evidence_mismatch",
      });
    let temporary: string | undefined;
    try {
      await mkdir(dirname(bundle.directory), { recursive: true, mode: 0o700 });
      temporary = await mkdtemp(
        join(dirname(bundle.directory), ".unpublished-"),
      );
      const directory = temporary;
      for (const relative of bundle.tree.directories) {
        const path = join(directory, relative);
        if (!isPathContained(directory, path))
          return err({
            _tag: "InsightEvidenceFailure",
            reason: "evidence_mismatch",
          });
        await mkdir(path, { recursive: true, mode: 0o700 });
      }
      // Files already begun finish; an abort stops the rest and the unpublished directory is removed below.
      const written = await mapConcurrent(bundle.sources, 4, async (file) =>
        options.signal?.aborted
          ? undefined
          : writeAtomicFile(join(directory, file.name), file.text),
      );
      if (
        options.signal?.aborted ||
        written.some((result) => result?._tag === "err")
      )
        return err({
          _tag: "InsightEvidenceFailure",
          reason: "evidence_unavailable",
        });
      if (
        !(await evidencePathIsOwned(
          this.paths.dataDirectory(),
          bundle.directory,
        ))
      )
        return err({
          _tag: "InsightEvidenceFailure",
          reason: "evidence_mismatch",
        });
      // Directories stay writable so ordinary removal works; post-invocation validation rejects any added or changed entry.
      await Promise.all(
        bundle.sources.map((file) => chmod(join(directory, file.name), 0o444)),
      );
      await rename(temporary, bundle.directory);
      temporary = undefined;
      return await this.validate(bundle, options);
    } catch {
      // A crash can publish this run directory before its Insight record commits.
      return this.validate(bundle, options);
    } finally {
      if (
        temporary !== undefined &&
        (await evidencePathIsOwned(this.paths.dataDirectory(), temporary))
      )
        await rm(temporary, { recursive: true, force: true });
    }
  }

  /** Validates the entire required set even when the agent never read a damaged file. */
  async validate(
    bundle: InsightEvidenceBundle,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<Result<void, InsightEvidenceFailure>> {
    if (!this.owns(bundle))
      return err({
        _tag: "InsightEvidenceFailure",
        reason: "evidence_mismatch",
      });
    try {
      if (
        !(await evidencePathIsOwned(
          this.paths.dataDirectory(),
          bundle.directory,
        ))
      )
        return err({
          _tag: "InsightEvidenceFailure",
          reason: "evidence_mismatch",
        });
      return validateInsightEvidenceTree(
        this.paths.dataDirectory(),
        bundle,
        options.signal,
      );
    } catch {
      return err({
        _tag: "InsightEvidenceFailure",
        reason: "evidence_unavailable",
      });
    }
  }

  private owns(bundle: InsightEvidenceBundle): boolean {
    const identity = bundle.identity;
    return (
      bundle.tree?.format === "insight-evidence-tree/1" &&
      /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(identity.runId) &&
      bundle.directory ===
        this.paths.analysisEvidenceDirectory(
          identity.profileId,
          identity.sessionId,
          identity.runId,
        )
    );
  }
}
