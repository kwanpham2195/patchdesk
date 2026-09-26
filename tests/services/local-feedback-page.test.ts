import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { parseRepoRelativePath } from "../../src/domain/ids";
import type { LocalFeedback } from "../../src/services/local-draft-service";
import {
  cleanupLocalApplyRoots,
  localApplyHarness,
  profileId,
  value,
  type LocalApplyHarness,
} from "./local-apply-fixture";

afterEach(cleanupLocalApplyRoots);

/** ADR 0052 "Feedback size": the serialized bound on one `get_feedback` page. */
const PAGE_BOUND_BYTES = 60 * 1024;
const path = value(parseRepoRelativePath("long.txt"));

/** A local Review of a 30-line file with one note per text, on lines 1, 2, and so on. */
async function reviewWithNotes(texts: ReadonlyArray<string>) {
  const harness = await localApplyHarness();
  await writeFile(
    join(harness.repositoryPath, "long.txt"),
    Array.from(
      { length: 30 },
      (_, index) => `line ${String(index + 1)}\n`,
    ).join(""),
  );
  const workbench = await harness.open();
  for (const [index, text] of texts.entries())
    value(
      await harness.drafts.addNote({
        profileId,
        reviewId: workbench.review.id,
        sessionId: workbench.session.id,
        anchor: { path, side: "new", startLine: index + 1, line: index + 1 },
        text,
      }),
    );
  return { harness, reviewId: workbench.review.id };
}

/** Follows `nextCursor` to the end; stops after one page per note so a cursor that never advances fails instead of hanging. */
async function readEveryPage(
  harness: LocalApplyHarness,
  reviewId: LocalFeedback["reviewId"],
  notes: number,
): Promise<ReadonlyArray<LocalFeedback>> {
  const pages: Array<LocalFeedback> = [];
  let cursor: string | undefined;
  do {
    const page = value(
      await harness.drafts.feedback(profileId, reviewId, cursor),
    );
    pages.push(page);
    cursor = page.nextCursor;
  } while (cursor !== undefined && pages.length <= notes);
  return pages;
}

function noteText(entry: LocalFeedback["localDrafts"][number]): string {
  if (entry.kind !== "note") throw new Error("expected a note");
  return entry.text;
}

describe("get_feedback page bound", () => {
  it("pages 25 notes of 60,000 characters under the byte bound and reaches each note exactly once with its full text", async () => {
    const texts = Array.from({ length: 25 }, (_, index) =>
      `${String(index + 1)} `.padEnd(60_000, "x"),
    );
    const { harness, reviewId } = await reviewWithNotes(texts);

    const pages = await readEveryPage(harness, reviewId, texts.length);

    expect(pages.at(-1)?.nextCursor).toBeUndefined();
    for (const page of pages)
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(
        PAGE_BOUND_BYTES,
      );
    expect(pages.flatMap((page) => page.localDrafts.map(noteText))).toEqual(
      texts,
    );
  });

  it("sends a note over the bound on its own alone, with its full text, between pages of the notes around it", async () => {
    const oversize = "y".repeat(65_536);
    const { harness, reviewId } = await reviewWithNotes([
      "Before the long note.",
      oversize,
      "After the long note.",
    ]);

    const pages = await readEveryPage(harness, reviewId, 3);

    expect(
      pages.map((page) => page.localDrafts.map(({ line }) => line)),
    ).toEqual([[1], [2], [3]]);
    expect(pages[1]?.localDrafts.map(noteText)).toEqual([oversize]);
    expect(pages[1]?.markdown).not.toContain(oversize);
  });

  it("keeps notes that fit the bound together on one page with the prompt for each", async () => {
    const texts = ["x".repeat(20_000), "y".repeat(5_000)];
    const { harness, reviewId } = await reviewWithNotes(texts);

    const pages = await readEveryPage(harness, reviewId, 2);

    expect(pages).toHaveLength(1);
    expect(pages[0]?.localDrafts.map(noteText)).toEqual(texts);
    for (const text of texts) expect(pages[0]?.markdown).toContain(text);
  });
});
