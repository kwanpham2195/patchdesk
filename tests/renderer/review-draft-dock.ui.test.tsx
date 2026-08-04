// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";

import { ReviewDraftDock } from "../../src/renderer/src/components/review-draft-dock";
import { createEmptyReviewBatch } from "../../src/domain/review-batch";
import { parseRepoRelativePath, parseReviewSessionId, parseIsoTimestamp } from "../../src/domain/ids";

const sessionId = parseReviewSessionId("github.com__centraldigital__patchdesk__pr-42__sha-aaaaaaaa__aaaaaaaaaaaa");
const now = parseIsoTimestamp("2026-08-01T00:00:00.000Z");
if (sessionId._tag === "err" || now._tag === "err") throw new Error("invalid fixture");

afterEach(cleanup);

it("keeps local draft editing available while GitHub writes are blocked", async () => {
  const batch = createEmptyReviewBatch({ sessionId: sessionId.value, createdAt: now.value });
  render(<ReviewDraftDock batch={batch} writeBlocked draftEditingBlocked={false} actions={{ addInlineComment: vi.fn(async () => undefined), removeItem: vi.fn(async () => undefined), addThreadReply: vi.fn(async () => undefined), setThreadState: vi.fn(async () => undefined), apply: vi.fn(async () => undefined), submit: vi.fn(async () => undefined) }} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: /Review draft/ }));
  expect(screen.getByRole("textbox", { name: "Review body" })).toHaveProperty("disabled", false);
  expect(screen.queryByRole("button", { name: "Create pending review" })).toBeNull();
});

it("reattaches an unsafe item only to the explicitly selected current diff range", async () => {
  const path = parseRepoRelativePath("src/a.ts");
  if (path._tag === "err") throw new Error("invalid fixture");
  const batch = {
    ...createEmptyReviewBatch({ sessionId: sessionId.value, createdAt: now.value }),
    items: [{
      _tag: "InlineComment",
      id: "unsafe-1",
      provenance: { _tag: "human" },
      source: "manual",
      anchor: { path: path.value, startLine: 1, line: 1, side: "new" },
      body: "Keep this guarded.",
      include: true,
      postability: "needs_attention",
      attention: { reason: "missing", originalAnchor: { path: path.value, startLine: 1, line: 1, side: "new" } },
    }],
  } as never;
  const repair = vi.fn(async () => undefined);
  const user = userEvent.setup();
  const { rerender } = render(<ReviewDraftDock batch={batch} patch={"diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+replacement\n"} writeBlocked={false} actions={{ addInlineComment: vi.fn(async () => undefined), removeItem: vi.fn(async () => undefined), addThreadReply: vi.fn(async () => undefined), setThreadState: vi.fn(async () => undefined), repairInlineAnchor: repair, convertInlineToGeneral: vi.fn(async () => undefined), apply: vi.fn(async () => undefined), submit: vi.fn(async () => undefined) }} />);
  await user.click(screen.getByRole("button", { name: /Review draft/ }));
  expect(screen.getByRole("button", { name: "Reattach selected line" })).toHaveProperty("disabled", true);
  rerender(<ReviewDraftDock batch={batch} patch={"diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+replacement\n"} selectedRepairAnchor={{ path: path.value, startLine: 1, line: 1, side: "new" }} writeBlocked={false} actions={{ addInlineComment: vi.fn(async () => undefined), removeItem: vi.fn(async () => undefined), addThreadReply: vi.fn(async () => undefined), setThreadState: vi.fn(async () => undefined), repairInlineAnchor: repair, convertInlineToGeneral: vi.fn(async () => undefined), apply: vi.fn(async () => undefined), submit: vi.fn(async () => undefined) }} />);
  await user.click(screen.getByRole("button", { name: "Reattach selected line" }));
  expect(repair).toHaveBeenCalledWith("unsafe-1", { path: path.value, startLine: 1, line: 1, side: "new" }, expect.objectContaining({ selectedLines: ["replacement"] }));
});

it("keeps the draft summary visible and expands the editor", async () => {
  const batch = createEmptyReviewBatch({ sessionId: sessionId.value, createdAt: now.value });
  render(<ReviewDraftDock batch={batch} writeBlocked={false} actions={{ addInlineComment: vi.fn(async () => undefined), removeItem: vi.fn(async () => undefined), addThreadReply: vi.fn(async () => undefined), setThreadState: vi.fn(async () => undefined), apply: vi.fn(async () => undefined), submit: vi.fn(async () => undefined) }} />);
  expect(screen.getByRole("region", { name: "Review draft dock" })).toBeDefined();
  expect(screen.getByText("0 included")).toBeDefined();
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: /Review draft/ }));
  expect(screen.getByRole("heading", { name: "Review batch" })).toBeDefined();
});
