import {
  compareGuideOthers,
  guideOtherSection,
} from "#src/domain/guide-others";
import { definedProps } from "#src/domain/defined-props";
import type {
  GuidePage,
  GuidePageRequest,
  GuideReadFailure,
  GuideSummary,
} from "#src/domain/guide-progress";
import {
  guideGroupCodec,
  guideInventoryEntryCodec,
  guideMemberCodec,
  type GuideGroup,
} from "#src/domain/guide-result";
import {
  parseReviewId,
  parseWorkspaceProfileId,
  type ReviewId,
  type WorkspaceProfileId,
} from "#src/domain/ids";
import { err, ok, type Result } from "#src/domain/result";
import type { GuideCapturedFilePages } from "./guide-captured-file-pages";
import type { GuideResultReader, GuideResultView } from "./guide-result-reader";
import type { GuideProgressService } from "./guide-result-progress";
import {
  GUIDE_FIRST_PART_UNITS,
  GUIDE_PAGE_BUDGET_BYTES,
  GUIDE_PAGE_MAX_ITEMS,
  GUIDE_TEXT_PART_UNITS,
  decodeCursor,
  encodedBytes,
  encodeCursor,
  fileSummaryOf,
} from "./guide-result-projection";

/** The encoded reply bound every page, including JSON escaping, must meet. */
const MAX_REPLY_BYTES = 32 * 1024;

/**
 * Bounded reading of the published Guide: a digest and count summary, then pages of groups, members, Others, long
 * text and progress marks. Nothing here rebuilds the whole result, embeds the patch or the complete inventory, or
 * computes membership: the worker already derived and stored Others. The reader orders that list for triage.
 */
type OthersPage = Extract<GuidePage, { kind: "others" }>;
type OthersOrder = Pick<OthersPage, "items" | "counts">;

export class GuidePageService {
  private othersOrder:
    | {
        readonly key: string;
        readonly value: Promise<Result<OthersOrder, GuideReadFailure>>;
      }
    | undefined;

  constructor(
    private readonly reader: GuideResultReader,
    private readonly progress: GuideProgressService,
    private readonly captured: GuideCapturedFilePages,
  ) {}

  async summary(
    profileId: WorkspaceProfileId,
    reviewId: ReviewId,
    nativeAttemptCursor?: string,
  ): Promise<Result<GuideSummary, GuideReadFailure>> {
    const current = await this.reader.summarySource(
      profileId,
      reviewId,
      nativeAttemptCursor,
    );
    if (current._tag === "err") return err(current.error);
    const { view, run, failure, nativeAttempts } = current.value;
    const details = definedProps({ nativeAttempts });
    if (view === undefined) {
      const summary: GuideSummary = { _tag: "none", run, failure, ...details };
      if (encodedBytes(summary) > MAX_REPLY_BYTES)
        delete summary.nativeAttempts;
      return ok(summary);
    }
    const [session, progress] = await Promise.all([
      this.reader.identityOf(view),
      this.progress.describe(view),
    ]);
    if (session._tag === "err") return err(session.error);
    if (progress._tag === "err") return progress;
    const summary: GuideSummary = {
      _tag: "ready",
      ...details,
      run,
      failure,
      runId: view.runId,
      ...session.value,
      digest: view.digest,
      generatedAt: view.generatedAt,
      groups: view.root.groups.count,
      inventory: view.root.inventory.count,
      others: view.root.others.count,
      completeness: view.root.contextCompleteness,
      progressVersion: progress.value.version,
      anchor: progress.value.anchor,
    };
    if (encodedBytes(summary) > MAX_REPLY_BYTES) delete summary.nativeAttempts;
    return ok(summary);
  }

  async page(
    request: GuidePageRequest,
  ): Promise<Result<GuidePage, GuideReadFailure>> {
    const profileId = parseWorkspaceProfileId(request.profileId);
    const reviewId = parseReviewId(request.reviewId);
    if (profileId._tag === "err" || reviewId._tag === "err")
      return err("not_available");
    const current = await this.reader.current(profileId.value, reviewId.value);
    if (current._tag === "err") return err(current.error);
    const view = current.value;
    if (view === undefined) return err("not_available");
    if (view.digest !== request.digest) return err("stale_result");
    const selector = request.page;
    let page: Result<GuidePage, GuideReadFailure>;
    switch (selector.kind) {
      case "groups":
        page = await this.groups(view, selector.cursor);
        break;
      case "members":
        page = await this.members(view, selector.groupId, selector.cursor);
        break;
      case "others":
        page = await this.others(view, selector.cursor);
        break;
      case "text":
        page = await this.text(view, selector);
        break;
      case "reviewed":
      case "expanded":
        page = await this.progress.readPage(
          view,
          selector.kind,
          selector.cursor,
        );
        break;
    }
    if (page._tag === "err") return page;
    return encodedBytes(page.value) > MAX_REPLY_BYTES
      ? err("invalid_result")
      : page;
  }

  private async groups(
    view: GuideResultView,
    cursor: string | null,
  ): Promise<Result<GuidePage, GuideReadFailure>> {
    const at = decodeCursor(cursor, {
      digest: view.digest,
      kind: "groups",
      scope: "",
    });
    if (at === undefined || at.p > view.root.groups.count)
      return err("invalid_cursor");
    const window = await view.store.readIndex(
      "GuideGroup1",
      view.root.groups,
      at.p,
      GUIDE_PAGE_MAX_ITEMS,
    );
    if (window._tag === "err") return err("invalid_result");
    const items: Extract<GuidePage, { kind: "groups" }>["items"] = [];
    let size = 0;
    for (const entry of window.value) {
      // react-doctor-disable-next-line react-doctor/async-await-in-loop -- a page is at most ten groups
      const group = await view.artifacts.readObject(
        view.profileId,
        view.reviewId,
        guideGroupCodec,
        entry.value,
      );
      if (group._tag === "err") return err("invalid_result");
      const item = await this.groupItem(view, group.value);
      if (item === undefined) return err("invalid_result");
      size += encodedBytes(item) + 1;
      if (items.length > 0 && size > GUIDE_PAGE_BUDGET_BYTES) break;
      items.push(item);
    }
    const consumed = at.p + items.length;
    return ok({
      kind: "groups",
      items,
      next:
        consumed < view.root.groups.count
          ? encodeCursor({ d: view.digest, k: "groups", s: "", p: consumed })
          : null,
    });
  }

  private async groupItem(view: GuideResultView, group: GuideGroup) {
    const [title, explanation] = await Promise.all([
      view.store.readText(group.title, 4_000),
      view.store.readTextPart(
        group.explanation,
        { block: 0, unit: 0 },
        GUIDE_FIRST_PART_UNITS,
      ),
    ]);
    if (title._tag === "err" || explanation._tag === "err") return undefined;
    const scope = `group_explanation:${group.id}`;
    return {
      id: group.id,
      title: title.value,
      memberCount: group.members.count,
      explanation: {
        text: explanation.value.text,
        next:
          explanation.value.next === null
            ? null
            : encodeCursor({
                d: view.digest,
                k: "text",
                s: scope,
                p: explanation.value.next.block,
                u: explanation.value.next.unit,
              }),
      },
    };
  }

  private async members(
    view: GuideResultView,
    groupId: string,
    cursor: string | null,
  ): Promise<Result<GuidePage, GuideReadFailure>> {
    const number = Number(groupId.slice(1));
    if (number < 1 || number > view.root.groups.count)
      return err("invalid_cursor");
    const at = decodeCursor(cursor, {
      digest: view.digest,
      kind: "members",
      scope: groupId,
    });
    if (at === undefined) return err("invalid_cursor");
    const located = await view.store.readIndex(
      "GuideGroup1",
      view.root.groups,
      number - 1,
      1,
    );
    const reference = located._tag === "ok" ? located.value[0] : undefined;
    if (reference === undefined) return err("invalid_result");
    const group = await view.artifacts.readObject(
      view.profileId,
      view.reviewId,
      guideGroupCodec,
      reference.value,
    );
    if (
      group._tag === "err" ||
      group.value.id !== groupId ||
      at.p > group.value.members.count
    )
      return err("invalid_result");
    const window = await view.store.readIndex(
      "GuideMember1",
      group.value.members,
      at.p,
      GUIDE_PAGE_MAX_ITEMS,
    );
    if (window._tag === "err") return err("invalid_result");
    const items: Extract<GuidePage, { kind: "members" }>["items"] = [];
    let size = 0;
    for (const entry of window.value) {
      // react-doctor-disable-next-line react-doctor/async-await-in-loop -- a page is at most ten members
      const member = await view.artifacts.readObject(
        view.profileId,
        view.reviewId,
        guideMemberCodec,
        entry.value,
      );
      if (member._tag === "err") return err("invalid_result");
      const [relevance, file] = await Promise.all([
        view.store.readTextPart(
          member.value.relevance,
          { block: 0, unit: 0 },
          GUIDE_FIRST_PART_UNITS,
        ),
        this.fileOf(view, member.value.fileId),
      ]);
      if (relevance._tag === "err" || file === undefined)
        return err("invalid_result");
      const item = {
        fileId: member.value.fileId,
        relevance: { text: relevance.value.text, next: null },
        file: file.summary,
      };
      size += encodedBytes(item) + 1;
      if (items.length > 0 && size > GUIDE_PAGE_BUDGET_BYTES) break;
      items.push(item);
    }
    const consumed = at.p + items.length;
    return ok({
      kind: "members",
      groupId: group.value.id,
      items,
      next:
        consumed < group.value.members.count
          ? encodeCursor({
              d: view.digest,
              k: "members",
              s: groupId,
              p: consumed,
            })
          : null,
    });
  }

  private async others(
    view: GuideResultView,
    cursor: string | null,
  ): Promise<Result<GuidePage, GuideReadFailure>> {
    const at = decodeCursor(cursor, {
      digest: view.digest,
      kind: "others",
      scope: "",
    });
    if (at === undefined || at.p > view.root.others.count)
      return err("invalid_cursor");
    const key = JSON.stringify([view.profileId, view.reviewId, view.digest]);
    if (this.othersOrder?.key !== key)
      this.othersOrder = { key, value: this.orderOthers(view) };
    const ordered = await this.othersOrder.value;
    if (ordered._tag === "err") {
      if (this.othersOrder?.key === key) this.othersOrder = undefined;
      return ordered;
    }
    const { items: files, counts } = ordered.value;
    const items: Extract<GuidePage, { kind: "others" }>["items"] = [];
    let size = 0;
    for (const item of files.slice(at.p, at.p + GUIDE_PAGE_MAX_ITEMS)) {
      size += encodedBytes(item) + 1;
      if (items.length > 0 && size > GUIDE_PAGE_BUDGET_BYTES) break;
      items.push(item);
    }
    const consumed = at.p + items.length;
    return ok({
      kind: "others",
      counts,
      items,
      next:
        consumed < view.root.others.count
          ? encodeCursor({ d: view.digest, k: "others", s: "", p: consumed })
          : null,
    });
  }

  /** Retain only the last result's metadata order; all index and entry reads stay bounded. */
  private async orderOthers(
    view: GuideResultView,
  ): Promise<Result<OthersOrder, GuideReadFailure>> {
    const ordered: Extract<GuidePage, { kind: "others" }>["items"] = [];
    const counts = { changed: 0, renamed: 0, deleted: 0 };
    for (
      let offset = 0;
      offset < view.root.others.count;
      offset += GUIDE_PAGE_MAX_ITEMS
    ) {
      // react-doctor-disable-next-line react-doctor/async-await-in-loop -- index reads stay bounded while ordering the stored Others list
      const window = await view.store.readIndex(
        "GuideInventoryEntry1",
        view.root.others,
        offset,
        GUIDE_PAGE_MAX_ITEMS,
      );
      if (window._tag === "err") return err("invalid_result");
      const files = await Promise.all(
        window.value.map((entry) => fileSummaryOf(view, entry.value)),
      );
      for (const file of files) {
        if (file === undefined) return err("invalid_result");
        ordered.push({ fileId: file.fileId, file: file.summary });
        counts[guideOtherSection(file.summary)] += 1;
      }
    }
    ordered.sort((left, right) => compareGuideOthers(left.file, right.file));
    return ok({ items: ordered, counts });
  }

  /** The inventory record for `fN` is at position N - 1: identities are assigned in patch order. */
  private async fileOf(view: GuideResultView, fileId: string) {
    const position = Number(fileId.slice(1)) - 1;
    if (position < 0 || position >= view.root.inventory.count) return undefined;
    const located = await view.store.readIndex(
      "GuideInventoryEntry1",
      view.root.inventory,
      position,
      1,
    );
    const reference = located._tag === "ok" ? located.value[0] : undefined;
    if (reference === undefined) return undefined;
    const file = await fileSummaryOf(view, reference.value);
    return file?.fileId === fileId ? file : undefined;
  }

  private async text(
    view: GuideResultView,
    selector: Extract<GuidePageRequest["page"], { kind: "text" }>,
  ): Promise<Result<GuidePage, GuideReadFailure>> {
    const field = selector.field;
    if (field.type === "captured_patch") {
      const captured = await this.captured.part(
        view,
        field.fileId,
        selector.cursor,
      );
      return captured._tag === "ok"
        ? ok({ kind: "text", part: captured.value })
        : captured;
    }
    const scope =
      field.type === "group_explanation"
        ? `group_explanation:${field.groupId}`
        : `inventory_entry:${field.fileId}`;
    const at = decodeCursor(selector.cursor, {
      digest: view.digest,
      kind: "text",
      scope,
    });
    if (at === undefined) return err("invalid_cursor");
    let root;
    if (field.type === "group_explanation") {
      const number = Number(field.groupId.slice(1));
      if (number < 1 || number > view.root.groups.count)
        return err("invalid_cursor");
      const located = await view.store.readIndex(
        "GuideGroup1",
        view.root.groups,
        number - 1,
        1,
      );
      const reference = located._tag === "ok" ? located.value[0] : undefined;
      if (reference === undefined) return err("invalid_result");
      const group = await view.artifacts.readObject(
        view.profileId,
        view.reviewId,
        guideGroupCodec,
        reference.value,
      );
      if (group._tag === "err" || group.value.id !== field.groupId)
        return err("invalid_result");
      root = group.value.explanation;
    } else {
      const position = Number(field.fileId.slice(1)) - 1;
      if (position < 0 || position >= view.root.inventory.count)
        return err("invalid_cursor");
      const located = await view.store.readIndex(
        "GuideInventoryEntry1",
        view.root.inventory,
        position,
        1,
      );
      const reference = located._tag === "ok" ? located.value[0] : undefined;
      if (reference === undefined) return err("invalid_result");
      const record = await view.artifacts.readObject(
        view.profileId,
        view.reviewId,
        guideInventoryEntryCodec,
        reference.value,
      );
      if (record._tag === "err" || record.value.fileId !== field.fileId)
        return err("invalid_result");
      root = record.value.entry;
    }
    const part = await view.store.readTextPart(
      root,
      { block: at.p, unit: at.u },
      GUIDE_TEXT_PART_UNITS,
    );
    if (part._tag === "err") return err("invalid_cursor");
    return ok({
      kind: "text",
      part: {
        text: part.value.text,
        next:
          part.value.next === null
            ? null
            : encodeCursor({
                d: view.digest,
                k: "text",
                s: scope,
                p: part.value.next.block,
                u: part.value.next.unit,
              }),
      },
    });
  }
}
