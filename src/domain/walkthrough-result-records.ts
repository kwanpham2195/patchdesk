import * as v from "valibot";
import { err, ok, type Result } from "./result";
import {
  walkthroughChapterIdSchema,
  walkthroughSectionIdSchema,
} from "./walkthrough-selectors.js";
import type {
  WalkthroughPayload,
  WalkthroughReceiptResult,
  WalkthroughRefusalReason,
} from "./walkthrough-protocol";

/** Ordered admission state retains IDs and counts, not all chapter/section prose or raw hunks. */
export class WalkthroughBuild {
  private started = false;
  private closed = false;
  private chapters = 0;
  private sections = 0;
  private chapterSections = 0;
  private sectionCitations = 0;
  private readonly cited = new Set<string>();

  constructor(private readonly hunks: ReadonlySet<string>) {}

  /** Whether finish has frozen the reading path. */
  get isClosed(): boolean {
    return this.closed;
  }

  /** Validates whole operations before changing ordering or citation membership. */
  apply(
    payload: WalkthroughPayload,
    position: {
      readonly sequence: number;
      readonly receipts: Extract<
        WalkthroughReceiptResult,
        { sequence: number }
      >["receipts"];
    },
  ): Result<WalkthroughReceiptResult, WalkthroughRefusalReason> {
    if (this.closed) return err("closed");
    if (payload.kind === "begin_walkthrough") {
      if (this.started) return err("already_started");
      this.started = true;
      return ok({ started: true });
    }
    if (!this.started) return err("not_started");
    switch (payload.kind) {
      case "open_chapter": {
        if (
          this.chapters > 0 &&
          (this.chapterSections === 0 || this.sectionCitations === 0)
        )
          return err("invalid_input");
        const id = v.safeParse(
          walkthroughChapterIdSchema,
          `c${this.chapters + 1}`,
        );
        if (!id.success) return err("invalid_input");
        this.chapters += 1;
        this.chapterSections = 0;
        return ok({ chapterId: id.output });
      }
      case "open_section": {
        if (payload.chapterId !== `c${this.chapters}`)
          return err("unknown_chapter");
        if (this.chapterSections > 0 && this.sectionCitations === 0)
          return err("invalid_input");
        const id = v.safeParse(
          walkthroughSectionIdSchema,
          `s${this.sections + 1}`,
        );
        if (!id.success) return err("invalid_input");
        this.sections += 1;
        this.chapterSections += 1;
        this.sectionCitations = 0;
        return ok({ chapterId: payload.chapterId, sectionId: id.output });
      }
      case "add_citations": {
        if (this.sections === 0 || payload.sectionId !== `s${this.sections}`)
          return err("unknown_section");
        const batch = new Set<string>();
        for (const id of payload.hunkIds) {
          if (!this.hunks.has(id)) return err("unknown_hunk");
          if (this.cited.has(id) || batch.has(id))
            return err("duplicate_citation");
          batch.add(id);
        }
        for (const id of batch) this.cited.add(id);
        this.sectionCitations += batch.size;
        return ok({ sectionId: payload.sectionId, count: batch.size });
      }
      case "finish":
        if (
          this.chapters === 0 ||
          this.chapterSections === 0 ||
          this.sectionCitations === 0
        )
          return err("invalid_input");
        this.closed = true;
        return ok(position);
    }
  }
}
