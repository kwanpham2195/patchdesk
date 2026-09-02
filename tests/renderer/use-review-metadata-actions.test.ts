// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { RawJsonValue } from "../../src/domain/json";
import type { RecentReviewWrite } from "../../src/domain/recent-review-write";
import {
  useReviewMetadataActions,
  type ReviewMetadataActions,
} from "../../src/renderer/src/flows/use-review-metadata-actions";
import {
  failure,
  installDesktopDouble,
  success,
} from "./fake-desktop-response";
import { projection } from "./review-workbench-fixtures";

afterEach(() => cleanup());

type ActionCase = {
  readonly name: string;
  readonly path: string;
  readonly operation:
    | "AddLabels"
    | "RemoveLabels"
    | "AddAssignees"
    | "RemoveAssignees"
    | "RequestReviewers"
    | "RemoveReviewers";
  readonly invoke: (
    actions: ReviewMetadataActions,
  ) => Promise<void | ReadonlyArray<string>>;
  readonly receipt: RawJsonValue;
  readonly wrongReceipt: RawJsonValue;
  readonly evidence: RecentReviewWrite;
};

const cases: ReadonlyArray<ActionCase> = [
  {
    name: "AddLabels",
    path: "/v1/reviews/labels/command",
    operation: "AddLabels",
    invoke: (a) => a.addLabels([{ id: "LA_bug", name: "bug" }]),
    receipt: { _tag: "LabelsAdded", added: ["bug"] },
    wrongReceipt: { _tag: "LabelsAdded", added: ["other"] },
    evidence: { _tag: "LabelChange", added: ["bug"], removed: [] },
  },
  {
    name: "RemoveLabels",
    path: "/v1/reviews/labels/command",
    operation: "RemoveLabels",
    invoke: (a) => a.removeLabels([{ id: "LA_bug", name: "bug" }]),
    receipt: { _tag: "LabelsRemoved", removed: ["bug"] },
    wrongReceipt: { _tag: "LabelsAdded", added: ["bug"] },
    evidence: { _tag: "LabelChange", added: [], removed: ["bug"] },
  },
  {
    name: "AddAssignees",
    path: "/v1/reviews/assignees/command",
    operation: "AddAssignees",
    invoke: (a) => a.addAssignees([{ id: "U_1", login: "octocat" }]),
    receipt: { _tag: "AssigneesAdded", added: ["octocat"] },
    wrongReceipt: { _tag: "AssigneesAdded", added: ["hubot"] },
    evidence: { _tag: "AssigneeChange", added: ["octocat"], removed: [] },
  },
  {
    name: "RemoveAssignees",
    path: "/v1/reviews/assignees/command",
    operation: "RemoveAssignees",
    invoke: (a) => a.removeAssignees([{ id: "U_1", login: "octocat" }]),
    receipt: { _tag: "AssigneesRemoved", removed: ["octocat"] },
    wrongReceipt: { _tag: "AssigneesAdded", added: ["octocat"] },
    evidence: { _tag: "AssigneeChange", added: [], removed: ["octocat"] },
  },
  {
    name: "AssignSelf",
    path: "/v1/reviews/assignees/command",
    operation: "AddAssignees",
    invoke: (a) => a.assignSelf(),
    receipt: { _tag: "AssigneesAdded", added: ["octocat"] },
    wrongReceipt: { _tag: "AssigneesAdded", added: ["octocat", "hubot"] },
    evidence: { _tag: "AssigneeChange", added: ["octocat"], removed: [] },
  },
  {
    name: "RequestReviewers",
    path: "/v1/reviews/reviewers/command",
    operation: "RequestReviewers",
    invoke: (a) => a.requestReviewers([{ id: "U_2", login: "hubot" }]),
    receipt: { _tag: "ReviewersRequested", requested: ["hubot"] },
    wrongReceipt: { _tag: "ReviewersRemoved", removed: ["hubot"] },
    evidence: { _tag: "ReviewerChange", requested: ["hubot"], removed: [] },
  },
  {
    name: "RemoveReviewers",
    path: "/v1/reviews/reviewers/command",
    operation: "RemoveReviewers",
    invoke: (a) => a.removeReviewers([{ id: "U_2", login: "hubot" }]),
    receipt: { _tag: "ReviewersRemoved", removed: ["hubot"] },
    wrongReceipt: { _tag: "ReviewersRemoved", removed: ["other"] },
    evidence: { _tag: "ReviewerChange", requested: [], removed: ["hubot"] },
  },
];

function renderActions(
  path: string,
  response: ReturnType<typeof success> | ReturnType<typeof failure>,
  observe = vi.fn(async () => undefined),
) {
  installDesktopDouble({
    [path]: async () => response,
  });
  const requireRecovery = vi.fn();
  const appendRecentWrites = vi.fn();
  const rendered = renderHook(() =>
    useReviewMetadataActions({
      workbench: projection(),
      runDirectCommand: async (operation) => await operation(),
      appendRecentWrites,
      observeConfirmedReviewWrite: observe,
      requireRecovery,
    }),
  );
  return { ...rendered, requireRecovery, appendRecentWrites, observe };
}

describe("useReviewMetadataActions", () => {
  for (const row of cases) {
    it(`${row.name} accepts only its exact confirmation and observes once`, async () => {
      const rendered = renderActions(row.path, success(row.receipt));
      await act(async () => {
        await row.invoke(rendered.result.current);
      });
      expect(rendered.appendRecentWrites).toHaveBeenCalledExactlyOnceWith(
        row.evidence,
      );
      expect(rendered.observe).toHaveBeenCalledExactlyOnceWith([row.evidence]);
      expect(rendered.requireRecovery).not.toHaveBeenCalled();
    });

    it(`${row.name} sends wrong tag or membership to its exact recovery operation`, async () => {
      const rendered = renderActions(row.path, success(row.wrongReceipt));
      await act(async () => {
        await expect(row.invoke(rendered.result.current)).rejects.toThrow();
      });
      expect(rendered.requireRecovery).toHaveBeenCalledExactlyOnceWith(
        row.operation,
      );
      expect(rendered.appendRecentWrites).not.toHaveBeenCalled();
      expect(rendered.observe).not.toHaveBeenCalled();
    });
  }

  it("rejects strict-schema malformed 2xx confirmation", async () => {
    const rendered = renderActions(
      "/v1/reviews/labels/command",
      success({ _tag: "LabelsAdded", added: ["bug"], extra: true }),
    );
    await act(async () => {
      await expect(
        rendered.result.current.addLabels([{ id: "LA_bug", name: "bug" }]),
      ).rejects.toThrow();
    });
    expect(rendered.requireRecovery).toHaveBeenCalledExactlyOnceWith(
      "AddLabels",
    );
  });

  it("requires the configured viewer identity for a one-member AssignSelf receipt", async () => {
    const rendered = renderActions(
      "/v1/reviews/assignees/command",
      success({ _tag: "AssigneesAdded", added: ["other-user"] }),
    );
    await act(async () => {
      await expect(rendered.result.current.assignSelf()).rejects.toThrow();
    });
    expect(rendered.requireRecovery).toHaveBeenCalledExactlyOnceWith(
      "AddAssignees",
    );
    expect(rendered.appendRecentWrites).not.toHaveBeenCalled();
    expect(rendered.observe).not.toHaveBeenCalled();
  });

  it("enters recovery for transport uncertainty", async () => {
    const rendered = renderActions(
      "/v1/reviews/reviewers/command",
      failure({ error: "outcome_unknown" }, 409),
    );
    await act(async () => {
      await expect(
        rendered.result.current.removeReviewers([
          { id: "U_1", login: "hubot" },
        ]),
      ).rejects.toThrow();
    });
    expect(rendered.requireRecovery).toHaveBeenCalledExactlyOnceWith(
      "RemoveReviewers",
    );
  });

  it("does not let observation failure reject durable confirmation", async () => {
    const observe = vi.fn(async () => {
      throw new Error("read failed");
    });
    const rendered = renderActions(
      "/v1/reviews/assignees/command",
      success({ _tag: "AssigneesAdded", added: ["octocat"] }),
      observe,
    );
    await expect(
      act(async () => rendered.result.current.assignSelf()),
    ).resolves.toEqual(["octocat"]);
    await vi.waitFor(() => expect(observe).toHaveBeenCalledOnce());
    expect(rendered.requireRecovery).not.toHaveBeenCalled();
  });
});
