import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { InsightEvidenceStore } from "#src/adapters/storage/insight-evidence-store";
import { evidencePathIsOwned } from "#src/adapters/storage/insight-evidence-validation";
import type { PatchdeskPaths } from "#src/adapters/storage/patchdesk-paths";
import { briefManifest } from "#src/domain/brief";
import { definedProps } from "#src/domain/defined-props";
import { buildGuideInventory } from "#src/domain/guide";
import {
  type InsightEvidenceBundle,
  type InsightEvidenceFailure,
  type InsightEvidenceIdentity,
  type EvidenceRecord,
  type EvidenceSource,
  type EvidenceSite,
  type EvidencePageId,
} from "#src/domain/insight-evidence";
import {
  fragmentEvidenceText,
  fragmentEvidenceLines,
} from "#src/domain/insight-evidence-fragments";
import { InsightEvidencePages } from "#src/domain/insight-evidence-pages";
import { narrativeHunkManifest } from "#src/domain/narrative-walkthrough";
import { err, ok, type Result } from "#src/domain/result";
import { iterateUnifiedPatch } from "#src/domain/unified-patch";
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
      counts: { readonly sources: number; readonly pages: number },
    ) => Promise<void>;
    readonly snapshots: (
      context: string,
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
          : await readBoundedArtifact(input.patchPath, 2 * 1024 * 1024);
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
      const snapshots =
        identity.type === "analysis"
          ? await input.snapshots(contextRead.value)
          : {};
      const bundle = buildBundle({
        identity,
        patch,
        context: contextRead.value,
        reviewInput,
        snapshots,
        directory: this.paths.insightEvidenceDirectory(
          identity.profileId,
          identity.sessionId,
          identity.runId,
        ),
      });
      if (bundle._tag === "err") return bundle;
      const counts = {
        sources: bundle.value.sources.length,
        pages: bundle.value.pages.length,
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

function buildBundle(input: {
  readonly identity: InsightEvidenceIdentity;
  readonly patch: string;
  readonly context: string;
  readonly reviewInput: string;
  readonly snapshots: Readonly<Record<string, string>>;
  readonly directory: string;
}): Result<InsightEvidenceBundle, InsightEvidenceFailure> {
  let hasFiles = false;
  for (const token of iterateUnifiedPatch(input.patch)) {
    if (token.kind !== "file_header") continue;
    hasFiles = true;
    break;
  }
  const inventory = hasFiles ? buildGuideInventory(input.patch) : ok([]);
  if (inventory._tag === "err")
    return err({ _tag: "InsightEvidenceFailure", reason: "evidence_mismatch" });
  const sources: Array<EvidenceSource> = [];
  const addSource = (text: string): EvidenceSource => {
    const source = {
      id: `s${sources.length + 1}`,
      name: `source-${sources.length + 1}.txt`,
      text,
      sha256: hashReviewArtifactContent(text),
    };
    sources.push(source);
    return source;
  };
  const patch = addSource(input.patch);
  const allowedContext =
    input.identity.type === "brief" ? [] : [addSource(input.context)];
  if (input.identity.type === "analysis")
    allowedContext.push(addSource(input.reviewInput));
  const identitySource = addSource(JSON.stringify(input.identity));
  const briefCitations = briefManifest({ patch: input.patch });
  const narrativeCitations = narrativeHunkManifest(input.patch);
  const citationText = JSON.stringify(
    input.identity.type === "brief"
      ? briefCitations
      : narrativeCitations._tag === "ok"
        ? narrativeCitations.value
        : [],
  );
  const citationSource = addSource(citationText);
  const snapshotSources = new Map(
    Object.entries(input.snapshots).map(([path, text]) => [
      path,
      addSource(text),
    ]),
  );
  const bundleId = hashReviewArtifactContent(
    JSON.stringify({
      identity: input.identity,
      sources: sources.map((source) => ({
        id: source.id,
        sha256: source.sha256,
      })),
    }),
  );
  const pages = new InsightEvidencePages(bundleId);
  const fragment = (
    source: EvidenceSource,
    site: EvidenceSite = {},
  ): ReadonlyArray<EvidenceRecord> =>
    fragmentEvidenceLines({ sourceId: source.id, text: source.text, site });
  const fileRecords: Array<Array<EvidenceRecord>> = [];
  let fileIndex = -1;
  let aliasIndex = 0;
  let hunkAlias: string | undefined;
  let byteStart = 0;
  let characterStart = 0;
  const canonicalAliases = new Set(
    input.identity.type === "brief"
      ? briefCitations.map((entry) => entry.alias)
      : narrativeCitations._tag === "ok"
        ? narrativeCitations.value.map((entry) => entry.id)
        : [],
  );
  for (const token of iterateUnifiedPatch(input.patch)) {
    if (token.kind === "file_header") {
      fileIndex += 1;
      fileRecords.push([]);
      hunkAlias = undefined;
    }
    if (token.kind === "hunk_header") {
      aliasIndex += 1;
      const alias = `h${aliasIndex}`;
      hunkAlias = canonicalAliases.has(alias) ? alias : undefined;
    }
    characterStart += token.raw.length;
    const newline = characterStart < input.patch.length ? "\n" : "";
    characterStart += newline.length;
    const text = token.raw + newline;
    const file = inventory.value[fileIndex];
    const records = fileRecords[fileIndex];
    if (records !== undefined)
      records.push(
        ...fragmentEvidenceText({
          sourceId: patch.id,
          text,
          byteStart,
          site: {
            ...definedProps({
              fileId: file?.id,
              hunkAlias,
              oldLine: token.kind === "body" ? token.oldLine : undefined,
              newLine: token.kind === "body" ? token.newLine : undefined,
            }),
            sourceLine: token.index + 1,
          },
        }),
      );
    else if (hasFiles && text.length > 0)
      return err({
        _tag: "InsightEvidenceFailure",
        reason: "evidence_mismatch",
      });
    byteStart += Buffer.byteLength(text);
  }
  const inventoryRecords: Array<EvidenceRecord> = [];
  if (!hasFiles) {
    const state = addSource(JSON.stringify({ state: "no_indexable_files" }));
    inventoryRecords.push(...fragment(state), {
      kind: "link",
      relation: "diff",
      pageId: pages.add(fragment(patch)),
    });
  }
  for (const [index, file] of inventory.value.entries()) {
    const diffPage = pages.add(fileRecords[index] ?? []);
    const snapshot = snapshotSources.get(file.newPath);
    const snapshotPage =
      snapshot === undefined
        ? undefined
        : pages.add(fragment(snapshot, { fileId: file.id }));
    const metadata = addSource(
      JSON.stringify({
        ...file,
        snapshot: snapshot === undefined ? "not_captured" : "captured",
      }),
    );
    inventoryRecords.push(...fragment(metadata, { fileId: file.id }), {
      kind: "link",
      relation: "diff",
      pageId: diffPage,
      fileId: file.id,
    });
    if (snapshotPage !== undefined)
      inventoryRecords.push({
        kind: "link",
        relation: "snapshot",
        pageId: snapshotPage,
        fileId: file.id,
      });
  }
  const inventoryPaths = new Set<string>(
    inventory.value.map((file) => file.newPath),
  );
  for (const [path, source] of snapshotSources) {
    if (inventoryPaths.has(path)) continue;
    const metadata = addSource(
      JSON.stringify({
        snapshotPath: path,
        snapshot: "captured",
        diff: "not_represented",
      }),
    );
    inventoryRecords.push(...fragment(metadata), {
      kind: "link",
      relation: "snapshot",
      pageId: pages.add(fragment(source)),
    });
  }
  const inventoryPage = pages.add(inventoryRecords);
  const citationPage = pages.add(fragment(citationSource));
  const contextPages = allowedContext.map((source) =>
    pages.add(fragment(source)),
  );
  const identityPage = pages.add(fragment(identitySource));
  const links: Array<EvidenceRecord> = [
    { kind: "link", relation: "inventory", pageId: inventoryPage },
    { kind: "link", relation: "citations", pageId: citationPage },
    { kind: "link", relation: "identity", pageId: identityPage },
    ...contextPages.map((pageId): EvidenceRecord => ({
      kind: "link",
      relation: "context",
      pageId,
    })),
  ];
  const entryPageId: EvidencePageId = pages.add(links);
  const encoded = pages
    .pages()
    .map((page) => ({ ...page, sha256: hashReviewArtifactContent(page.text) }));
  const manifestText = JSON.stringify({
    identity: input.identity,
    bundleId,
    entryPageId,
    pages: encoded.map((page) => ({ id: page.id, sha256: page.sha256 })),
    sources: sources.map(({ id, name, sha256 }) => ({ id, name, sha256 })),
  });
  return ok({
    identity: input.identity,
    bundleId,
    directory: input.directory,
    entryPageId,
    pages: encoded,
    sources,
    manifestText,
    patchPath: join(input.directory, patch.name),
  });
}
