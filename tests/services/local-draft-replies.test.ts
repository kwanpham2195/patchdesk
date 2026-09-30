import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  parseFindingId,
  parseLocalNoteId,
  parseRepoRelativePath,
} from "../../src/domain/ids";
import {
  cleanupLocalApplyRoots,
  localApplyHarness,
  now,
  profileId,
  retainAnalysis,
  suggestionFinding,
  value,
} from "./local-apply-fixture";

afterEach(cleanupLocalApplyRoots);

const probe = [
  "export function sum(values: number[]): number {",
  "  let total = 0;",
  "  for (let index = 0; index <= values.length; index += 1) {",
  "    total += values[index] ?? 0;",
  "  }",
  "  return total;",
  "}",
  "",
].join("\n");
const probePath = value(parseRepoRelativePath("probe.ts"));
const firstNote = value(parseLocalNoteId("note-fixture-1"));
const secondNote = value(parseLocalNoteId("note-fixture-2"));

/** A local Review of `probe.ts` with a note on line 3, and on line 2 when `two` is set. */
async function notedReview(two = false) {
  const harness = await localApplyHarness();
  await writeFile(join(harness.repositoryPath, "probe.ts"), probe);
  const workbench = await harness.open();
  const key = {
    profileId,
    reviewId: workbench.review.id,
    sessionId: workbench.session.id,
  };
  const lines = two ? [3, 2] : [3];
  for (const line of lines)
    value(
      await harness.drafts.addNote({
        view: "combined",
        ...key,
        anchor: { path: probePath, side: "new", startLine: line, line },
        text: `Check line ${String(line)}.`,
      }),
    );
  return { harness, workbench, key };
}

describe("agent replies and Resolve on Local drafts (#600)", () => {
  it("stores a reply apart from the note, keeps it across a move, and replaces it with the next reply", async () => {
    const { harness, key } = await notedReview();
    const before = value(await harness.reviews.load(profileId, key.reviewId));

    const replied = await harness.drafts.reply({
      profileId,
      reviewId: key.reviewId,
      draftId: firstNote,
      status: "question",
      text: "Should the loop stop before values.length?",
    });
    const stored = value(await harness.reviews.load(profileId, key.reviewId));
    await writeFile(
      join(harness.repositoryPath, "probe.ts"),
      `${probe}export const more = 1;\n`,
    );
    const moved = await harness.open();
    const afterMove = value(
      await harness.drafts.feedback(profileId, key.reviewId),
    );
    value(
      await harness.drafts.reply({
        profileId,
        reviewId: key.reviewId,
        draftId: firstNote,
        status: "addressed",
        text: "Changed <= to <.",
      }),
    );
    const replaced = value(
      await harness.drafts.feedback(profileId, key.reviewId),
    );

    expect(replied).toEqual({
      _tag: "ok",
      value: {
        draftId: firstNote,
        status: "question",
        repliedAt: now,
        resolved: false,
      },
    });
    expect(stored.localDrafts).toEqual(before.localDrafts);
    expect(moved.session.id).not.toBe(key.sessionId);
    expect(moved.localDraftReplies).toEqual([
      {
        draft: { noteId: firstNote },
        status: "question",
        text: "Should the loop stop before values.length?",
        repliedAt: now,
      },
    ]);
    expect(afterMove.localDrafts).toMatchObject([
      {
        draftId: firstNote,
        text: "Check line 3.",
        startLine: 3,
        state: "unchanged",
        resolved: false,
        reply: {
          status: "question",
          text: "Should the loop stop before values.length?",
        },
      },
    ]);
    expect(afterMove.markdown).not.toContain("Should the loop stop");
    expect(replaced.localDrafts).toMatchObject([
      { reply: { status: "addressed", text: "Changed <= to <." } },
    ]);
  });

  it("leaves a resolved note out of get_feedback with open: true and out of the prompt, and Reopen brings it back", async () => {
    const { harness, key } = await notedReview(true);
    value(await harness.drafts.handOff(key));

    const resolved = await harness.drafts.setResolved({
      ...key,
      draft: { noteId: firstNote },
      resolved: true,
    });
    const open = value(
      await harness.drafts.feedback(profileId, key.reviewId, { open: true }),
    );
    const all = value(await harness.drafts.feedback(profileId, key.reviewId));
    const prompt = value(
      await harness.drafts.agentPrompt(profileId, key.reviewId),
    );
    value(
      await harness.drafts.setResolved({
        ...key,
        draft: { noteId: firstNote },
        resolved: false,
      }),
    );
    const reopened = value(
      await harness.drafts.feedback(profileId, key.reviewId, { open: true }),
    );

    expect(resolved).toMatchObject({
      _tag: "ok",
      value: {
        localDrafts: [
          { noteId: firstNote, resolvedAt: now },
          { noteId: secondNote },
        ],
        feedbackHandoff: { changedSinceHandoff: true },
      },
    });
    expect(open.localDrafts.map((entry) => entry.draftId)).toEqual([
      secondNote,
    ]);
    expect(all.localDrafts).toMatchObject([
      { draftId: secondNote, resolved: false },
      { draftId: firstNote, resolved: true },
    ]);
    for (const markdown of [open.markdown, all.markdown, prompt.markdown]) {
      expect(markdown).toContain("Check line 2.");
      expect(markdown).not.toContain("Check line 3.");
    }
    expect(reopened.localDrafts.map((entry) => entry.draftId)).toEqual([
      secondNote,
      firstNote,
    ]);
  });

  it("refuses a credential-shaped reply and a reply to a removed note, and drops a note's reply with the note", async () => {
    const { harness, key } = await notedReview(true);
    const reply = {
      profileId,
      reviewId: key.reviewId,
      status: "skipped" as const,
      text: "Left as is; the caller checks the bound.",
    };
    value(await harness.drafts.reply({ ...reply, draftId: firstNote }));
    value(await harness.drafts.reply({ ...reply, draftId: secondNote }));

    const sensitive = await harness.drafts.reply({
      ...reply,
      draftId: secondNote,
      // Assembled at runtime so the source holds no token a secret scanner would flag.
      text: `The token was ghp_${"a".repeat(36)}.`,
    });
    value(await harness.drafts.removeNote({ ...key, noteId: firstNote }));
    const removed = await harness.drafts.reply({
      ...reply,
      draftId: firstNote,
    });
    const stored = value(await harness.reviews.load(profileId, key.reviewId));

    expect([sensitive, removed]).toEqual([
      { _tag: "err", error: { reason: "reply_sensitive" } },
      { _tag: "err", error: { reason: "draft_not_found" } },
    ]);
    expect(stored.localDraftReplies).toEqual([
      {
        draft: { noteId: secondNote },
        status: "skipped",
        text: "Left as is; the caller checks the bound.",
        repliedAt: now,
      },
    ]);
  });

  it("takes a Finding draft's draftId from get_feedback as the reply's target", async () => {
    const harness = await localApplyHarness();
    await writeFile(join(harness.repositoryPath, "probe.ts"), probe);
    const workbench = await harness.open();
    const runId = await retainAnalysis(harness.insights, workbench, [
      suggestionFinding(
        "finding-bound",
        "probe.ts",
        { start: 3, end: 3 },
        "  for (let index = 0; index < values.length; index += 1) {",
      ),
    ]);
    value(
      await harness.drafts.add({
        profileId,
        reviewId: workbench.review.id,
        sessionId: workbench.session.id,
        runId,
        findingId: value(parseFindingId("finding-bound")),
      }),
    );
    const [entry] = value(
      await harness.drafts.feedback(profileId, workbench.review.id),
    ).localDrafts;

    const replied = await harness.drafts.reply({
      profileId,
      reviewId: workbench.review.id,
      draftId: entry?.draftId ?? "",
      status: "addressed",
      text: "Applied the bound fix.",
    });

    expect(entry?.draftId).toBe(`${runId}/finding-bound`);
    expect(replied).toMatchObject({
      _tag: "ok",
      value: { draftId: `${runId}/finding-bound`, status: "addressed" },
    });
  });
});
