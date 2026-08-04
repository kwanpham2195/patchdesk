// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { PublishedFeedbackPanel } from "../../src/renderer/src/components/published-feedback";
import type { WorkbenchResponse } from "../../src/renderer/src/renderer-contracts";

afterEach(cleanup);

const feedback: WorkbenchResponse["publishedFeedback"] = {
  reviews: [{ id: "review-1", author: "maintainer", body: "Please address this.", event: "CHANGES_REQUESTED", submittedAt: "2026-08-01T00:00:00.000Z", canDismiss: true }],
  comments: [{ id: "comment-1", author: "maintainer", body: "Use the shared parser.", createdAt: "2026-08-01T00:00:00.000Z", location: { path: "src/parser.ts", line: 12, lineEnd: 12, diffSide: "new" }, canEdit: true, canDelete: true }],
};

it("renders remote feedback and keeps destructive actions behind confirmation", async () => {
  const actions = { editComment: vi.fn(async () => undefined), deleteComment: vi.fn(async () => undefined), dismissReview: vi.fn(async () => undefined) };
  render(<PublishedFeedbackPanel feedback={feedback} freshness="fresh" actions={actions} />);
  expect(screen.getByRole("heading", { name: "Published feedback" })).toBeDefined();
  expect(screen.getByText("Use the shared parser.")).toBeDefined();
  fireEvent.click(screen.getByRole("button", { name: "Delete" }));
  expect(screen.getByRole("alertdialog")).toBeDefined();
  expect(actions.deleteComment).not.toHaveBeenCalled();
  const deleteButtons = screen.getAllByRole("button", { name: "Delete" });
  const confirmDelete = deleteButtons[deleteButtons.length - 1];
  if (confirmDelete === undefined) throw new Error("delete confirmation is missing");
  fireEvent.click(confirmDelete);
  expect(actions.deleteComment).toHaveBeenCalledWith("comment-1");
});

it("hides mutations when the represented Review has updates or is not writable", () => {
  const actions = { editComment: vi.fn(async () => undefined), deleteComment: vi.fn(async () => undefined), dismissReview: vi.fn(async () => undefined) };
  render(<PublishedFeedbackPanel feedback={feedback} freshness="updates_available" actions={actions} />);
  expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Dismiss" })).toBeNull();
  cleanup();
  render(<PublishedFeedbackPanel feedback={feedback} freshness="fresh" canWriteGitHub={false} actions={actions} />);
  expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Dismiss" })).toBeNull();
});
