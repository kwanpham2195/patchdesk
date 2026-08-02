// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";

import { PublicationPreviewDialog } from "../../src/renderer/src/components/publication-preview-dialog";
import type { PublicationPreviewResponse } from "../../src/renderer/src/renderer-contracts";

afterEach(cleanup);

const preview: PublicationPreviewResponse = { reviewId: "review-1", sessionId: "session-1", headSha: "a".repeat(40), draftRevision: "2026-08-01T00:00:00.000Z", event: "COMMENT", body: "# Review", inlineComments: [{ itemId: "item-1", path: "src/a.ts", startLine: 2, line: 2, side: "new", body: "Please simplify this." }], threadActions: [], warnings: [] };

it("opens automatically after an explicit completion choice", async () => {
  const previewRequest = vi.fn(async () => preview);
  const consumed = vi.fn();
  render(<PublicationPreviewDialog onPreview={previewRequest} onConfirm={async () => undefined} autoOpen onAutoOpenConsumed={consumed} />);
  expect(await screen.findByText("# Review")).toBeDefined();
  expect(previewRequest).toHaveBeenCalledOnce();
  expect(consumed).toHaveBeenCalledOnce();
});

it("shows the exact body and requires explicit publication confirmation", async () => {
  const confirm = vi.fn(async () => undefined);
  render(<PublicationPreviewDialog onPreview={async () => preview} onConfirm={confirm} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Preview publication" }));
  expect(screen.getByText("# Review")).toBeDefined();
  expect(screen.getByText("Please simplify this.")).toBeDefined();
  expect(confirm).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Confirm publication" }));
  expect(confirm).toHaveBeenCalledOnce();
});
