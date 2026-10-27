import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readdir, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

import { mapConcurrent } from "#src/domain/map-concurrent";
import { encodedEvidenceResponseBytes } from "#src/domain/insight-evidence-pages";
import { definedProps } from "#src/domain/defined-props";
import {
  EVIDENCE_PAGE_BYTES,
  parseEvidencePageId,
  type InsightEvidenceBundle,
  type InsightEvidenceFailure,
  type EvidenceSearchMatch,
  type EvidenceSearchResult,
} from "#src/domain/insight-evidence";
import { err, ok, type Result } from "#src/domain/result";
import { makeInsightEvidenceTreeRemovable } from "./insight-evidence-tree-removal";
import { validateInsightEvidenceTree } from "./insight-evidence-tree-validation";
import { isPathContained } from "./path-containment";
import { writeAtomicFile } from "./json-file";
import {
  evidencePathIsOwned,
  readEvidenceFile,
  validateEvidenceFile,
} from "./insight-evidence-validation";
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
      if (bundle.tree !== undefined) {
        for (const relative of bundle.tree.directories) {
          const path = join(directory, relative);
          if (!isPathContained(directory, path))
            return err({
              _tag: "InsightEvidenceFailure",
              reason: "evidence_mismatch",
            });
          await mkdir(path, { recursive: true, mode: 0o700 });
        }
      }
      // Files already begun finish; an abort stops the rest and the unpublished directory is removed below.
      const written = await mapConcurrent(files(bundle), 4, async (file) =>
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
      if (bundle.tree !== undefined) {
        await Promise.all(
          files(bundle).map((file) => chmod(join(directory, file.name), 0o444)),
        );
        // Directory modes keep the execute bit, so the order of these chmods does not matter.
        await Promise.all(
          [...bundle.tree.directories, ""].map((relative) =>
            chmod(join(directory, relative), 0o555),
          ),
        );
      }
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
      ) {
        const removable =
          bundle.tree === undefined
            ? ok(undefined)
            : await makeInsightEvidenceTreeRemovable(
                this.paths.dataDirectory(),
                temporary,
              );
        if (removable._tag === "ok")
          await rm(temporary, { recursive: true, force: true });
      }
    }
  }

  /** Validates the entire required set even when the agent never read a damaged page. */
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
      if (bundle.tree !== undefined)
        return validateInsightEvidenceTree(
          this.paths.dataDirectory(),
          bundle,
          options.signal,
        );
      const expected = files(bundle);
      const names = await readdir(bundle.directory);
      const expectedNames = new Set(expected.map((file) => file.name));
      if (
        names.length !== expected.length ||
        names.some((name) => !expectedNames.has(name))
      )
        return err({
          _tag: "InsightEvidenceFailure",
          reason: "evidence_mismatch",
        });
      const checked = await mapConcurrent(expected, 4, (file) =>
        options.signal?.aborted
          ? Promise.resolve(
              err({
                _tag: "InsightEvidenceFailure",
                reason: "evidence_unavailable",
              } as const),
            )
          : validateEvidenceFile({
              root: this.paths.dataDirectory(),
              path: join(bundle.directory, file.name),
              sha256: file.sha256,
              bytes: Buffer.byteLength(file.text),
            }),
      );
      const failed = checked.find((result) => result._tag === "err");
      return failed?._tag === "err" ? failed : ok(undefined);
    } catch {
      return err({
        _tag: "InsightEvidenceFailure",
        reason: "evidence_unavailable",
      });
    }
  }

  /** Returns one unchanged NDJSON page after checking its exact owned bytes. */
  async readPage(
    bundle: InsightEvidenceBundle,
    rawPageId: string,
  ): Promise<Result<string, InsightEvidenceFailure>> {
    const id = parseEvidencePageId(rawPageId);
    const page = bundle.pages.find((candidate) => candidate.id === id);
    if (!this.owns(bundle) || id === undefined || page === undefined)
      return err({ _tag: "InsightEvidenceFailure", reason: "invalid_input" });
    const checked = await this.validate(bundle);
    if (checked._tag === "err") return checked;
    return readEvidenceFile({
      root: this.paths.dataDirectory(),
      path: join(bundle.directory, `${id}.ndjson`),
      sha256: page.sha256,
      bytes: Buffer.byteLength(page.text),
    });
  }

  /** Literal search uses logical source text, including matches crossing fragment boundaries. */
  async search(
    bundle: InsightEvidenceBundle,
    query: string,
    cursor?: string,
  ): Promise<Result<EvidenceSearchResult, InsightEvidenceFailure>> {
    if (query.length === 0 || query.length > 200 || query.includes("\0"))
      return err({ _tag: "InsightEvidenceFailure", reason: "invalid_input" });
    const prefix = `${bundle.bundleId}:${digest(query)}:`;
    const position =
      cursor === undefined
        ? [0, 0]
        : cursor.startsWith(prefix) &&
            /^\d+:\d+$/.test(cursor.slice(prefix.length))
          ? cursor.slice(prefix.length).split(":").map(Number)
          : [];
    let sourceIndex = position[0];
    let offset = position[1];
    if (
      position.length !== 2 ||
      sourceIndex === undefined ||
      offset === undefined ||
      !Number.isSafeInteger(sourceIndex) ||
      !Number.isSafeInteger(offset) ||
      sourceIndex < 0 ||
      offset < 0 ||
      sourceIndex >= bundle.sources.length
    )
      return err({ _tag: "InsightEvidenceFailure", reason: "invalid_input" });
    const checked = await this.validate(bundle);
    if (checked._tag === "err") return checked;
    const matches: Array<EvidenceSearchMatch> = [];
    for (; sourceIndex < bundle.sources.length; sourceIndex += 1, offset = 0) {
      const source = bundle.sources[sourceIndex];
      if (source === undefined || offset > source.text.length)
        return err({ _tag: "InsightEvidenceFailure", reason: "invalid_input" });
      for (;;) {
        const found = source.text.indexOf(query, offset);
        if (found < 0) break;
        const byteStart = Buffer.byteLength(source.text.slice(0, found));
        const page = bundle.pages.find((candidate) =>
          candidate.records.some(
            (record) =>
              record.kind === "fragment" &&
              record.sourceId === source.id &&
              record.byteStart <= byteStart &&
              record.byteEnd > byteStart,
          ),
        );
        const site = page?.records.find(
          (record) =>
            record.kind === "fragment" &&
            record.sourceId === source.id &&
            record.byteStart <= byteStart &&
            record.byteEnd > byteStart,
        );
        if (page === undefined || site?.kind !== "fragment")
          return err({
            _tag: "InsightEvidenceFailure",
            reason: "evidence_mismatch",
          });
        const match: EvidenceSearchMatch = {
          sourceId: source.id,
          byteStart,
          byteEnd: byteStart + Buffer.byteLength(query),
          pageId: page.id,
          ...definedProps({
            fileId: site.fileId,
            hunkAlias: site.hunkAlias,
            oldLine: site.oldLine,
            newLine: site.newLine,
            sourceLine: site.sourceLine,
          }),
        };
        const next = `${prefix}${sourceIndex}:${found + 1}`;
        if (
          encodedEvidenceResponseBytes(
            JSON.stringify({ matches: [...matches, match], cursor: next }),
          ) > EVIDENCE_PAGE_BYTES
        )
          return ok({ matches, cursor: `${prefix}${sourceIndex}:${found}` });
        matches.push(match);
        offset = found + 1;
      }
    }
    return ok({ matches, cursor: null });
  }

  private owns(bundle: InsightEvidenceBundle): boolean {
    const identity = bundle.identity;
    return (
      /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(identity.runId) &&
      bundle.directory ===
        (bundle.tree === undefined
          ? this.paths.insightEvidenceDirectory.bind(this.paths)
          : this.paths.analysisEvidenceDirectory.bind(this.paths))(
          identity.profileId,
          identity.sessionId,
          identity.runId,
        )
    );
  }
}

function digest(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
function files(bundle: InsightEvidenceBundle) {
  if (bundle.tree !== undefined) return bundle.sources;
  return [
    ...bundle.pages.map((page) => ({
      name: `${page.id}.ndjson`,
      text: page.text,
      sha256: page.sha256,
    })),
    ...bundle.sources.map((source) => ({
      name: source.name,
      text: source.text,
      sha256: source.sha256,
    })),
    {
      name: "manifest.json",
      text: bundle.manifestText,
      sha256: digest(bundle.manifestText),
    },
  ];
}
