import type { WorkspaceProfileId, ReviewId } from "#src/domain/ids";
import { definedProps } from "#src/domain/defined-props";
import { parseWorkspaceProfileId, parseReviewId } from "#src/domain/ids";
import type {
  WalkthroughPage,
  WalkthroughPageRequest,
  WalkthroughReadFailure,
  WalkthroughSummary,
} from "#src/domain/walkthrough-progress";
import {
  walkthroughCitationCodec,
  walkthroughSectionCodec,
} from "#src/domain/walkthrough-result";
import { walkthroughHunkCodec } from "#src/domain/walkthrough-preparation";
import { err, ok, type Result } from "#src/domain/result";
import { decodeCursor, encodeCursor } from "./guide-result-projection";
import {
  walkthroughReadFailure,
  type WalkthroughResultReader,
  type WalkthroughResultView,
} from "./walkthrough-result-reader";
import {
  walkthroughChapter,
  walkthroughRecordAt,
  walkthroughSection,
  walkthroughSelectedHunk,
} from "./walkthrough-result-records";
import type { WalkthroughProgressService } from "./walkthrough-result-progress";

// MCP sends both escaped text and structured content, so both must fit the reply budget.
function replyBytes<T>(value: T): number {
  return Buffer.byteLength(
    JSON.stringify({
      content: [{ type: "text", text: JSON.stringify(value) }],
      structuredContent: value,
    }),
  );
}

/** Summary and bounded pages over the published graph. No read can dispatch a provider request. */
export class WalkthroughPageService {
  constructor(
    private readonly reader: WalkthroughResultReader,
    private readonly progress: WalkthroughProgressService,
  ) {}

  /** All consumers use the same counts, bound revision, provenance and progress. */
  async summary(
    profileId: WorkspaceProfileId,
    reviewId: ReviewId,
    nativeAttemptCursor?: string,
  ): Promise<Result<WalkthroughSummary, WalkthroughReadFailure>> {
    const source = await this.reader.summarySource(
      profileId,
      reviewId,
      nativeAttemptCursor,
    );
    if (source._tag === "err") return source;
    const { view, run, failure, nativeAttempts } = source.value;
    if (view === undefined) {
      const summary: WalkthroughSummary = {
        _tag: "none",
        run,
        failure,
        ...definedProps({ nativeAttempts }),
      };
      if (replyBytes(summary) > 32768) delete summary.nativeAttempts;
      return ok(summary);
    }
    const title = await view.store.readText(view.root.title, 800);
    if (title._tag === "err") return err(walkthroughReadFailure(title.error));
    const focus = await view.store.readText(view.root.focus, 1280);
    if (focus._tag === "err") return err(walkthroughReadFailure(focus.error));
    const progress = await this.progress.describe(view);
    if (progress._tag === "err") return progress;
    if (
      title.value.length > 200 ||
      title.value.trim() !== title.value ||
      title.value.length === 0 ||
      focus.value.length > 320 ||
      focus.value.trim() !== focus.value ||
      focus.value.length === 0
    )
      return err("invalid_result");
    const summary: WalkthroughSummary = {
      _tag: "ready",
      ...definedProps({ nativeAttempts }),
      run,
      failure,
      digest: view.digest,
      runId: view.runId,
      ...view.metadata,
      title: title.value,
      focus: focus.value,
      chapters: view.root.chapters.count,
      sections: view.root.sections.count,
      hunks: view.root.hunks.count,
      citedHunks: view.root.citedHunks,
      uncited: view.root.uncited.count,
      completeness: view.root.contextCompleteness,
      progressVersion: progress.value.version,
      currentSectionId: progress.value.currentSectionId,
      reviewedCount: progress.value.reviewedCount,
    };
    if (replyBytes(summary) > 32768) delete summary.nativeAttempts;
    return replyBytes(summary) <= 32768 ? ok(summary) : err("invalid_result");
  }

  /** Rejects stale digests before following any selector or cursor. */
  async page(
    request: WalkthroughPageRequest,
  ): Promise<Result<WalkthroughPage, WalkthroughReadFailure>> {
    const profileId = parseWorkspaceProfileId(request.profileId);
    const reviewId = parseReviewId(request.reviewId);
    if (profileId._tag === "err" || reviewId._tag === "err")
      return err("not_available");
    const current = await this.reader.current(profileId.value, reviewId.value);
    if (current._tag === "err") return current;
    const view = current.value;
    if (view === undefined) return err("not_available");
    if (view.digest !== request.digest) return err("stale_result");
    const selector = request.page;
    let page: Result<WalkthroughPage, WalkthroughReadFailure>;
    switch (selector.kind) {
      case "navigation":
        page = await this.navigation(view, selector.cursor);
        break;
      case "section":
        page = await this.section(view, selector.sectionId);
        break;
      case "citations":
        page = await this.citations(view, selector.sectionId, selector.cursor);
        break;
      case "uncited":
        page = await this.citations(view, null, selector.cursor);
        break;
      case "hunk_text":
        page = await this.text(view, selector);
        break;
    }
    return page._tag === "err"
      ? page
      : replyBytes(page.value) <= 32768
        ? page
        : err("invalid_result");
  }

  private async navigation(
    view: WalkthroughResultView,
    cursor: string | null,
  ): Promise<Result<WalkthroughPage, WalkthroughReadFailure>> {
    const at = decodeCursor(cursor, {
      digest: view.digest,
      kind: "navigation",
      scope: "",
    });
    if (at === undefined || at.p > view.root.sections.count || at.u > 1)
      return err("invalid_cursor");
    const backwards = at.u === 1;
    const items: Extract<WalkthroughPage, { kind: "navigation" }>["items"] = [];
    for (let offset = 0; offset < 10; offset += 1) {
      const ordinal = backwards ? at.p - offset - 1 : at.p + offset;
      if (ordinal < 0 || ordinal >= view.root.sections.count) break;
      const section = await walkthroughRecordAt(
        view,
        "WalkthroughSection1",
        walkthroughSectionCodec,
        view.root.sections,
        ordinal,
      );
      if (section._tag === "err") return section;
      const record = section.value;
      if (record.id !== `s${ordinal + 1}`) return err("invalid_result");
      const title = await view.store.readText(record.title, 640);
      if (title._tag === "err") return err(walkthroughReadFailure(title.error));
      if (
        title.value.length > 160 ||
        title.value.trim() !== title.value ||
        title.value.length === 0
      )
        return err("invalid_result");
      const chapter = await walkthroughChapter(view, record.chapterId, ordinal);
      if (chapter._tag === "err") return chapter;
      const reviewed = await this.progress.reviewed(view, record.id);
      if (reviewed._tag === "err") return reviewed;
      const item = {
        sectionId: record.id,
        ordinal,
        title: title.value,
        chapter: chapter.value,
        reviewed: reviewed.value,
      };
      const next = encodeCursor({
        d: view.digest,
        k: "navigation",
        s: "",
        p: ordinal + 1,
      });
      if (
        items.length > 0 &&
        replyBytes({ kind: "navigation", items: [...items, item], next }) >
          24576
      )
        break;
      if (backwards) items.unshift(item);
      else items.push(item);
    }
    const start = backwards ? at.p - items.length : at.p;
    const consumed = backwards ? at.p : at.p + items.length;
    return ok({
      kind: "navigation",
      items,
      previous:
        start === 0
          ? null
          : encodeCursor({
              d: view.digest,
              k: "navigation",
              s: "",
              p: start,
              u: 1,
            }),
      next:
        consumed < view.root.sections.count
          ? encodeCursor({
              d: view.digest,
              k: "navigation",
              s: "",
              p: consumed,
            })
          : null,
    });
  }

  private async section(
    view: WalkthroughResultView,
    sectionId: string,
  ): Promise<Result<WalkthroughPage, WalkthroughReadFailure>> {
    const section = await walkthroughSection(view, sectionId);
    if (section._tag === "err") return section;
    const ordinal = Number(sectionId.slice(1)) - 1;
    const title = await view.store.readText(section.value.title, 640);
    if (title._tag === "err") return err(walkthroughReadFailure(title.error));
    const prose = await view.store.readText(section.value.prose, 1280);
    if (prose._tag === "err") return err(walkthroughReadFailure(prose.error));
    if (
      title.value.length > 160 ||
      title.value.trim() !== title.value ||
      title.value.length === 0 ||
      prose.value.length > 320 ||
      prose.value.trim() !== prose.value ||
      prose.value.length === 0
    )
      return err("invalid_result");
    const chapter = await walkthroughChapter(
      view,
      section.value.chapterId,
      ordinal,
    );
    if (chapter._tag === "err") return chapter;
    const reviewed = await this.progress.reviewed(view, sectionId);
    if (reviewed._tag === "err") return reviewed;
    return ok({
      kind: "section",
      sectionId,
      ordinal,
      title: title.value,
      prose: prose.value,
      chapter: chapter.value,
      citationCount: section.value.citations.count,
      previous: ordinal > 0 ? `s${ordinal}` : null,
      next: ordinal + 1 < view.root.sections.count ? `s${ordinal + 2}` : null,
      reviewed: reviewed.value,
      navigationCursor:
        ordinal === 0
          ? null
          : encodeCursor({
              d: view.digest,
              k: "navigation",
              s: "",
              p: ordinal,
            }),
    });
  }

  private async citations(
    view: WalkthroughResultView,
    sectionId: string | null,
    cursor: string | null,
  ): Promise<Result<WalkthroughPage, WalkthroughReadFailure>> {
    const kind = sectionId === null ? "uncited" : "citations";
    const at = decodeCursor(cursor, {
      digest: view.digest,
      kind,
      scope: sectionId ?? "",
    });
    if (at === undefined || at.u > 1 || (sectionId === null && at.u !== 0))
      return err("invalid_cursor");
    const backwards = at.u === 1;
    const section =
      sectionId === null ? null : await walkthroughSection(view, sectionId);
    if (section?._tag === "err") return section;
    const index =
      section === null ? view.root.uncited : section.value.citations;
    if (at.p > index.count) return err("invalid_cursor");
    const items: Extract<WalkthroughPage, { kind: "uncited" }>["items"] = [];
    for (let offset = 0; offset < 10; offset += 1) {
      const ordinal = backwards ? at.p - offset - 1 : at.p + offset;
      if (ordinal < 0 || ordinal >= index.count) break;
      let hunk;
      if (section === null)
        hunk = await walkthroughRecordAt(
          view,
          "WalkthroughHunk1",
          walkthroughHunkCodec,
          index,
          ordinal,
        );
      else {
        const citation = await walkthroughRecordAt(
          view,
          "WalkthroughCitation1",
          walkthroughCitationCodec,
          index,
          ordinal,
        );
        if (citation._tag === "err") return citation;
        const storedHunk = await view.artifacts.readObject(
          view.profileId,
          view.reviewId,
          walkthroughHunkCodec,
          citation.value.hunk,
        );
        if (storedHunk._tag === "err")
          return err(walkthroughReadFailure(storedHunk.error));
        hunk = storedHunk;
        if (hunk.value.id !== citation.value.hunkId)
          return err("invalid_result");
      }
      if (hunk._tag === "err") return hunk;
      const path = await view.store.readTextPart(
        hunk.value.path,
        { block: 0, unit: 0 },
        512,
      );
      if (path._tag === "err") return err(walkthroughReadFailure(path.error));
      const { id, oldStart, oldLines, newStart, newLines } = hunk.value;
      const item = {
        hunkId: id,
        oldStart,
        oldLines,
        newStart,
        newLines,
        path: {
          text: path.value.text,
          next:
            path.value.next === null
              ? null
              : encodeCursor({
                  d: view.digest,
                  k: "hunk_text",
                  s: `${sectionId ?? ""}:${id}:path`,
                  p: path.value.next.block,
                  u: path.value.next.unit,
                }),
        },
      };
      if (
        items.length > 0 &&
        replyBytes({
          kind,
          items: [...items, item],
          next: "x".repeat(512),
          sectionId,
        }) > 24576
      )
        break;
      if (backwards) items.unshift(item);
      else items.push(item);
    }
    const start = backwards ? at.p - items.length : at.p;
    const consumed = backwards ? at.p : at.p + items.length;
    const next =
      consumed < index.count
        ? encodeCursor({
            d: view.digest,
            k: kind,
            s: sectionId ?? "",
            p: consumed,
          })
        : null;
    return sectionId === null
      ? ok({ kind: "uncited", items, next })
      : ok({
          kind: "citations",
          sectionId,
          items,
          next,
          previous:
            start === 0
              ? null
              : encodeCursor({
                  d: view.digest,
                  k: kind,
                  s: sectionId,
                  p: start,
                  u: 1,
                }),
        });
  }

  private async text(
    view: WalkthroughResultView,
    selector: Extract<WalkthroughPageRequest["page"], { kind: "hunk_text" }>,
  ): Promise<Result<WalkthroughPage, WalkthroughReadFailure>> {
    const scope = `${selector.sectionId ?? ""}:${selector.hunkId}:${selector.field}`;
    const at = decodeCursor(selector.cursor, {
      digest: view.digest,
      kind: "hunk_text",
      scope,
    });
    if (at === undefined) return err("invalid_cursor");
    const hunk = await walkthroughSelectedHunk(
      view,
      selector.sectionId,
      selector.hunkId,
    );
    if (hunk._tag === "err") return hunk;
    // 2,048 units fit even when each unit is escaped twice in MCP's text envelope.
    const part = await view.store.readTextPart(
      hunk.value[selector.field],
      { block: at.p, unit: at.u },
      2048,
    );
    if (part._tag === "err") return err(walkthroughReadFailure(part.error));
    return ok({
      kind: "hunk_text",
      text: part.value.text,
      next:
        part.value.next === null
          ? null
          : encodeCursor({
              d: view.digest,
              k: "hunk_text",
              s: scope,
              p: part.value.next.block,
              u: part.value.next.unit,
            }),
    });
  }
}
