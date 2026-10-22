import * as v from "valibot";
import type {
  InsightArtifactCodec,
  InsightIndexElement,
} from "#src/domain/insight-artifact-index";
import {
  encodeInsightArtifactCanonicalJson,
  type InsightCanonicalValue,
  type InsightArtifactIndexDescriptor,
  type InsightArtifactReference,
  type InsightTextRootDescriptor,
} from "#src/domain/insight-artifact-scalars";
import type { ReviewId, WorkspaceProfileId } from "#src/domain/ids";
import type { WalkthroughPreparedInput } from "#src/domain/walkthrough-preparation";
import {
  walkthroughChapterCodec,
  walkthroughSectionCodec,
  walkthroughCitationCodec,
  walkthroughValidationCodec,
  walkthroughResultRootCodec,
} from "#src/domain/walkthrough-result";
import type {
  WalkthroughPayload,
  WalkthroughReceiptResult,
} from "#src/domain/walkthrough-protocol";
import type { GuideValidationInput } from "./guide-result-job";
import type { InsightArtifactStore } from "./insight-artifact-store";
import { InsightResultStore } from "./insight-result-store";
import { InsightIndexBuilder } from "./insight-index-builder";

/** Keeps only the current section and chapter, flushing them to indexes in reading order. */
export class WalkthroughGraphWriter {
  private readonly store: InsightResultStore;
  private chapters: InsightArtifactIndexDescriptor | undefined;
  private sections: InsightArtifactIndexDescriptor | undefined;
  private citations: InsightArtifactIndexDescriptor | undefined;
  private chapter:
    | {
        id: v.InferOutput<typeof walkthroughChapterCodec.schema>["id"];
        title: InsightTextRootDescriptor;
        firstSection: number;
      }
    | undefined;
  private section:
    | {
        id: v.InferOutput<typeof walkthroughSectionCodec.schema>["id"];
        chapterId: v.InferOutput<typeof walkthroughChapterCodec.schema>["id"];
        title: InsightTextRootDescriptor;
        prose: InsightTextRootDescriptor;
      }
    | undefined;
  private title: InsightTextRootDescriptor | undefined;
  private focus: InsightTextRootDescriptor | undefined;
  private readonly cited = new Set<string>();

  constructor(
    private readonly artifacts: InsightArtifactStore,
    private readonly profileId: WorkspaceProfileId,
    private readonly reviewId: ReviewId,
    private readonly input: GuideValidationInput,
    private readonly prepared: WalkthroughPreparedInput,
    private readonly options: { readonly signal?: AbortSignal },
  ) {
    this.store = new InsightResultStore(artifacts, profileId, reviewId);
  }

  /** Initializes typed output indexes. */
  async initialize(): Promise<boolean> {
    const [chapters, sections] = await Promise.all([
      this.store.emptyIndex("WalkthroughChapter1"),
      this.store.emptyIndex("WalkthroughSection1"),
    ]);
    if (chapters._tag === "err" || sections._tag === "err") return false;
    this.chapters = chapters.value;
    this.sections = sections.value;
    return true;
  }

  /** Stores each independently replayed operation without retaining earlier prose. */
  async emit(
    payload: WalkthroughPayload,
    result: WalkthroughReceiptResult,
  ): Promise<boolean> {
    if (this.options.signal?.aborted) return false;
    switch (payload.kind) {
      case "begin_walkthrough": {
        this.title = await this.text(payload.title);
        this.focus = await this.text(payload.focus);
        return this.title !== undefined && this.focus !== undefined;
      }
      case "open_chapter": {
        if (
          !(await this.flushSection()) ||
          !(await this.flushChapter()) ||
          !("chapterId" in result)
        )
          return false;
        const title = await this.text(payload.title);
        if (title === undefined || this.sections === undefined) return false;
        this.chapter = {
          id: result.chapterId,
          title,
          firstSection: this.sections.count,
        };
        return true;
      }
      case "open_section": {
        if (
          !(await this.flushSection()) ||
          !("chapterId" in result) ||
          !("sectionId" in result)
        )
          return false;
        const [title, prose, citations] = await Promise.all([
          this.text(payload.title),
          this.text(payload.prose),
          this.store.emptyIndex("WalkthroughCitation1"),
        ]);
        if (
          title === undefined ||
          prose === undefined ||
          citations._tag === "err"
        )
          return false;
        this.section = {
          id: result.sectionId,
          chapterId: result.chapterId,
          title,
          prose,
        };
        this.citations = citations.value;
        return true;
      }
      case "add_citations": {
        for (const hunkId of payload.hunkIds) {
          const entries = await this.store.readIndex(
            "WalkthroughHunk1",
            this.prepared.hunks,
            Number(hunkId.slice(1)) - 1,
            1,
          );
          const hunk =
            entries._tag === "ok" ? entries.value[0]?.value : undefined;
          if (hunk === undefined || this.citations === undefined) return false;
          const reference = await this.object(walkthroughCitationCodec, {
            hunkId,
            hunk,
          });
          this.citations = await this.append(
            "WalkthroughCitation1",
            this.citations,
            reference,
          );
          if (this.citations === undefined) return false;
          this.cited.add(hunkId);
        }
        return true;
      }
      case "finish":
        return (await this.flushSection()) && (await this.flushChapter());
    }
  }

  /** Stores the complete ordered uncited complement, validation and root, with readback. */
  async finish(frozen: {
    readonly sequence: number;
    readonly receipts: InsightArtifactIndexDescriptor;
  }): Promise<
    | {
        readonly result: InsightArtifactReference;
        readonly validation: InsightArtifactReference;
        readonly counts: {
          readonly chapters: number;
          readonly sections: number;
          readonly citedHunks: number;
          readonly uncited: number;
          readonly receipts: number;
        };
      }
    | undefined
  > {
    if (
      this.chapters === undefined ||
      this.sections === undefined ||
      this.title === undefined ||
      this.focus === undefined
    )
      return undefined;
    const builder = new InsightIndexBuilder(
      this.artifacts,
      this.profileId,
      this.reviewId,
      "WalkthroughHunk1",
    );
    for (let at = 0; at < this.prepared.hunks.count; at += 16) {
      if (this.options.signal?.aborted) return undefined;
      const entries = await this.store.readIndex(
        "WalkthroughHunk1",
        this.prepared.hunks,
        at,
        16,
      );
      if (entries._tag === "err") return undefined;
      for (const [offset, entry] of entries.value.entries()) {
        if (this.cited.has(`h${at + offset + 1}`)) continue;
        if ((await builder.append(entry.value))._tag === "err")
          return undefined;
      }
    }
    const built = await builder.finish();
    if (built._tag === "err") return undefined;
    const uncited = built.value;
    let verified = 0;
    for (let at = 0; at < this.prepared.hunks.count; at += 16) {
      if (this.options.signal?.aborted) return undefined;
      const source = await this.store.readIndex(
        "WalkthroughHunk1",
        this.prepared.hunks,
        at,
        16,
      );
      if (source._tag === "err") return undefined;
      const expected = source.value.filter(
        (_, offset) => !this.cited.has(`h${at + offset + 1}`),
      );
      const stored = await this.store.readIndex(
        "WalkthroughHunk1",
        uncited,
        verified,
        expected.length,
      );
      if (
        stored._tag === "err" ||
        stored.value.some(
          (entry, offset) =>
            entry.key !== String(verified + offset).padStart(16, "0") ||
            entry.value.hash !== expected[offset]?.value.hash ||
            entry.value.bytes !== expected[offset]?.value.bytes,
        )
      )
        return undefined;
      verified += expected.length;
    }
    if (
      verified !== uncited.count ||
      this.cited.size + uncited.count !== this.prepared.hunks.count
    )
      return undefined;
    const graph = {
      binding: this.input.binding,
      preparation: this.input.preparation,
      frozenSequence: frozen.sequence,
      receipts: frozen.receipts,
      title: this.title,
      focus: this.focus,
      chapters: this.chapters,
      sections: this.sections,
      hunks: this.prepared.hunks,
      uncited,
      citedHunks: this.cited.size,
      contextCompleteness: this.prepared.contextCompleteness,
    };
    const validation = await this.object(walkthroughValidationCodec, {
      ...graph,
      generation: this.input.generation,
      cancelEpoch: this.input.cancelEpoch,
      validator: "walkthrough-citations-v1",
    });
    if (validation === undefined) return undefined;
    const result = await this.object(walkthroughResultRootCodec, {
      ...graph,
      validation,
    });
    return result === undefined
      ? undefined
      : {
          result,
          validation,
          counts: {
            chapters: this.chapters.count,
            sections: this.sections.count,
            citedHunks: this.cited.size,
            uncited: uncited.count,
            receipts: frozen.sequence,
          },
        };
  }

  private async flushSection(): Promise<boolean> {
    if (this.section === undefined) return true;
    if (this.citations === undefined || this.sections === undefined)
      return false;
    const reference = await this.object(walkthroughSectionCodec, {
      ...this.section,
      citations: this.citations,
    });
    this.sections = await this.append(
      "WalkthroughSection1",
      this.sections,
      reference,
    );
    this.section = undefined;
    return this.sections !== undefined;
  }

  private async flushChapter(): Promise<boolean> {
    if (this.chapter === undefined) return true;
    if (this.sections === undefined || this.chapters === undefined)
      return false;
    const reference = await this.object(walkthroughChapterCodec, {
      ...this.chapter,
      sectionCount: this.sections.count - this.chapter.firstSection,
    });
    this.chapters = await this.append(
      "WalkthroughChapter1",
      this.chapters,
      reference,
    );
    this.chapter = undefined;
    return this.chapters !== undefined;
  }

  private async text(
    value: string,
  ): Promise<InsightTextRootDescriptor | undefined> {
    const root = await this.artifacts.writeTextRoot(
      this.profileId,
      this.reviewId,
      value,
      this.options,
    );
    if (root._tag === "err") return undefined;
    return (
      await this.artifacts.verifyTextRootEquals(
        this.profileId,
        this.reviewId,
        root.value,
        value,
      )
    )._tag === "ok"
      ? root.value
      : undefined;
  }

  private async object<
    S extends v.GenericSchema<unknown, InsightCanonicalValue>,
  >(
    codec: InsightArtifactCodec<S>,
    value: v.InferInput<S>,
  ): Promise<InsightArtifactReference | undefined> {
    const root = await this.artifacts.writeObject(
      this.profileId,
      this.reviewId,
      codec,
      value,
    );
    if (root._tag === "err") return undefined;
    const stored = await this.artifacts.readObject(
      this.profileId,
      this.reviewId,
      codec,
      root.value,
    );
    return stored._tag === "ok" &&
      encodeInsightArtifactCanonicalJson(stored.value) ===
        encodeInsightArtifactCanonicalJson(v.parse(codec.schema, value))
      ? root.value
      : undefined;
  }

  private async append(
    element: InsightIndexElement,
    index: InsightArtifactIndexDescriptor,
    reference: InsightArtifactReference | undefined,
  ): Promise<InsightArtifactIndexDescriptor | undefined> {
    if (reference === undefined) return undefined;
    const next = await this.store.appendIndex(
      element,
      index,
      index.count,
      reference,
    );
    if (next._tag === "err" || next.value.count !== index.count + 1)
      return undefined;
    const read = await this.store.readIndex(
      element,
      next.value,
      index.count,
      1,
    );
    return read._tag === "ok" &&
      read.value[0]?.value.hash === reference.hash &&
      read.value[0].value.bytes === reference.bytes
      ? next.value
      : undefined;
  }
}
