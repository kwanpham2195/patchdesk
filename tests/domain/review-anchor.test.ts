import { describe, expect, it } from "vitest";

import { parseRepoRelativePath } from "../../src/domain/ids";
import {
  carryForwardReviewBatch,
  fingerprintPatchAnchor,
  matchPatchAnchor,
} from "../../src/domain/review-anchor";

const path = parseRepoRelativePath("src/example.ts");
if (path._tag === "err") throw new Error("Invalid test path");

const originalPatch = [
  "diff --git a/src/example.ts b/src/example.ts",
  "--- a/src/example.ts",
  "+++ b/src/example.ts",
  "@@ -1,5 +1,5 @@",
  " context before",
  "-old line",
  "+new line",
  " context after",
  " unchanged tail",
].join("\n");

describe("review anchor context", () => {
  it("matches a uniquely moved current-head line using exact context", () => {
    const fingerprint = fingerprintPatchAnchor(originalPatch, {
      path: path.value,
      startLine: 2,
      line: 2,
      side: "new",
    });

    expect(fingerprint).toMatchObject({
      selectedLines: ["new line"],
      before: ["context before"],
      after: ["context after", "unchanged tail"],
    });

    const currentPatch = originalPatch.replace(
      "@@ -1,5 +1,5 @@",
      "@@ -1,5 +1,6 @@",
    ).replace(
      " context before\n-old line",
      "+inserted before\n context before\n-old line",
    );
    const matches = fingerprint === undefined ? [] : matchPatchAnchor(currentPatch, fingerprint);

    expect(matches).toEqual([{
      path: path.value,
      startLine: 3,
      line: 3,
      side: "new",
    }]);
  });

  it("returns both candidates when the exact context is ambiguous", () => {
    const patch = [
      "diff --git a/src/example.ts b/src/example.ts",
      "--- a/src/example.ts",
      "+++ b/src/example.ts",
      "@@ -1,6 +1,6 @@",
      " context before",
      "+same line",
      " context after",
      " context before",
      "+same line",
      " context after",
    ].join("\n");
    expect(matchPatchAnchor(patch, {
      path: path.value,
      side: "new",
      startLine: 2,
      line: 2,
      selectedLines: ["same line"],
      before: [],
      after: [],
    })).toHaveLength(2);
  });

  it("carries every item forward and records unsafe inline drafts", () => {
    const exactFingerprint = fingerprintPatchAnchor(originalPatch, {
      path: path.value,
      startLine: 2,
      line: 2,
      side: "new",
    });
    if (exactFingerprint === undefined) throw new Error("Missing exact fingerprint");
    const missingFingerprint = {
      path: path.value,
      startLine: 20,
      line: 20,
      side: "new" as const,
    };
    const ambiguousFingerprint = {
      path: path.value,
      side: "new" as const,
      startLine: 2,
      line: 2,
      selectedLines: ["same line"],
      before: [],
      after: [],
    };
    const missingMatchFingerprint = {
      path: path.value,
      side: "new" as const,
      startLine: 2,
      line: 2,
      selectedLines: ["gone line"],
      before: [],
      after: [],
    };
    const source = {
      sessionId: "source-session",
      state: { _tag: "Local" as const },
      summaryBody: "Keep this summary",
      suggestedEvent: "REQUEST_CHANGES" as const,
      items: [
        {
          _tag: "InlineComment" as const,
          id: "exact" as never,
          provenance: { _tag: "model" as const, attemptId: "attempt" as never },
          source: "finding" as const,
          findingId: "finding" as never,
          anchor: { path: path.value, startLine: 2, line: 2, side: "new" as const },
          fingerprint: exactFingerprint,
          body: "Exact body",
          include: false,
          postability: "postable" as const,
        },
        {
          _tag: "InlineComment" as const,
          id: "ambiguous" as never,
          provenance: { _tag: "human" as const },
          source: "manual" as const,
          anchor: { path: path.value, startLine: 2, line: 2, side: "new" as const },
          fingerprint: ambiguousFingerprint,
          body: "Ambiguous body",
          include: true,
          postability: "postable" as const,
        },
        {
          _tag: "InlineComment" as const,
          id: "missing" as never,
          provenance: { _tag: "human" as const },
          source: "manual" as const,
          anchor: { path: path.value, startLine: 2, line: 2, side: "new" as const },
          fingerprint: missingMatchFingerprint,
          body: "Missing body",
          include: true,
          postability: "postable" as const,
        },
        {
          _tag: "InlineComment" as const,
          id: "no-fingerprint" as never,
          provenance: { _tag: "human" as const },
          source: "manual" as const,
          anchor: missingFingerprint,
          body: "No fingerprint body",
          include: true,
          postability: "postable" as const,
        },
        {
          _tag: "ThreadReply" as const,
          id: "reply" as never,
          provenance: { _tag: "human" as const },
          threadId: "thread" as never,
          body: "Reply body",
          include: false,
        },
        {
          _tag: "ThreadState" as const,
          id: "state" as never,
          provenance: { _tag: "model" as const, attemptId: "attempt" as never },
          threadId: "thread" as never,
          action: "resolve" as const,
          include: true,
        },
      ],
      receipts: [],
      createdAt: "2026-07-16T00:00:00.000Z" as never,
      updatedAt: "2026-07-16T00:00:00.000Z" as never,
    };
    const ambiguousSourceItem = source.items[1];
    if (ambiguousSourceItem === undefined) throw new Error("Missing ambiguous source item");
    const result = carryForwardReviewBatch({
      source: source as never,
      sourceHeadSha: "abcdef1234567890abcdef1234567890abcdef12" as never,
      targetSessionId: "target-session" as never,
      currentPatch: originalPatch,
      now: "2026-07-16T00:02:00.000Z" as never,
    });

    expect(result.attentionItemIds).toEqual(["ambiguous", "missing", "no-fingerprint"]);
    expect(result.batch).toMatchObject({ sessionId: "target-session", summaryBody: source.summaryBody, suggestedEvent: source.suggestedEvent });
    const carried = new Map(result.batch.items.map((item) => [item.id, item]));
    expect(carried.get("exact" as never)).toMatchObject({ postability: "postable", anchor: { startLine: 2, line: 2 } });
    expect(carried.get("ambiguous" as never)).toMatchObject({ postability: "needs_attention", body: "Ambiguous body", include: true, attention: { reason: "missing" } });
    expect(carried.get("missing" as never)).toMatchObject({ postability: "needs_attention", attention: { reason: "missing" } });
    expect(carried.get("no-fingerprint" as never)).toMatchObject({ postability: "needs_attention", attention: { reason: "fingerprint_missing" } });
    expect(carried.get("reply" as never)).toMatchObject({ body: "Reply body", include: false, provenance: { _tag: "human" } });
    expect(carried.get("state" as never)).toMatchObject({ action: "resolve", include: true, provenance: { _tag: "model" } });
    expect(result.batch.items).toHaveLength(source.items.length);
    expect(result.batch.items.every((item) => item.carriedFrom?.sourceSessionId === source.sessionId)).toBe(true);
    expect(result.batch.items.find((item) => item.id === "ambiguous")).toMatchObject({ attention: { originalAnchor: ambiguousSourceItem.anchor, originalFingerprint: ambiguousFingerprint } });
    expect(result.batch.items.find((item) => item.id === "no-fingerprint")).toMatchObject({ attention: { originalAnchor: missingFingerprint } });

    const ambiguousResult = carryForwardReviewBatch({
      source: { ...source, items: [ambiguousSourceItem] } as never,
      sourceHeadSha: "abcdef1234567890abcdef1234567890abcdef12" as never,
      targetSessionId: "target-session" as never,
      currentPatch: [
        "diff --git a/src/example.ts b/src/example.ts",
        "--- a/src/example.ts",
        "+++ b/src/example.ts",
        "@@ -1,6 +1,6 @@",
        " context before",
        "+same line",
        " context after",
        " context before",
        "+same line",
        " context after",
      ].join("\n"),
      now: "2026-07-16T00:02:00.000Z" as never,
    });
    expect(ambiguousResult).toMatchObject({ attentionItemIds: ["ambiguous"], batch: { items: [{ postability: "needs_attention", attention: { reason: "ambiguous" } }] } });

    const interrupted = carryForwardReviewBatch({
      source: {
        ...source,
        state: { _tag: "PartialFailure", operation: { _tag: "CreatePendingReview", itemIds: ["exact" as never] }, failure: { _tag: "SafeWriteFailure", category: "unavailable", message: "retry" } },
        receipts: [{ _tag: "ReplyCreated", itemId: "reply" as never, commentId: "comment" }],
      } as never,
      sourceHeadSha: "abcdef1234567890abcdef1234567890abcdef12" as never,
      targetSessionId: "target-session" as never,
      currentPatch: originalPatch,
      now: "2026-07-16T00:02:00.000Z" as never,
    });
    expect(interrupted.batch.state).toEqual({ _tag: "PartialFailure", operation: { _tag: "CreatePendingReview", itemIds: ["exact"] }, failure: { _tag: "SafeWriteFailure", category: "unavailable", message: "retry" } });
    expect(interrupted.batch.receipts).toEqual([{ _tag: "ReplyCreated", itemId: "reply", commentId: "comment" }]);
  });
});
