// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";

import { ReviewDraftDock } from "../../src/renderer/src/components/review-draft-dock";
import { createEmptyReviewBatch } from "../../src/domain/review-batch";
import { parseReviewSessionId, parseIsoTimestamp } from "../../src/domain/ids";

const sessionId = parseReviewSessionId("github.com__centraldigital__patchdesk__pr-42__sha-aaaaaaaa__aaaaaaaaaaaa");
const now = parseIsoTimestamp("2026-08-01T00:00:00.000Z");
if (sessionId._tag === "err" || now._tag === "err") throw new Error("invalid fixture");

afterEach(cleanup);

it("keeps the draft summary visible and expands the editor", async () => {
  const batch = createEmptyReviewBatch({ sessionId: sessionId.value, createdAt: now.value });
  render(<ReviewDraftDock batch={batch} writeBlocked={false} actions={{ addInlineComment: vi.fn(async () => undefined), removeItem: vi.fn(async () => undefined), addThreadReply: vi.fn(async () => undefined), setThreadState: vi.fn(async () => undefined), apply: vi.fn(async () => undefined), submit: vi.fn(async () => undefined) }} />);
  expect(screen.getByRole("region", { name: "Review draft dock" })).toBeDefined();
  expect(screen.getByText("0 included")).toBeDefined();
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: /Review draft/ }));
  expect(screen.getByRole("heading", { name: "Review batch" })).toBeDefined();
});
