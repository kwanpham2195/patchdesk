// @vitest-environment jsdom
import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { useReviewWorkbenchPosition } from "../../src/renderer/src/hooks/use-review-workbench-position";
import type { ReviewWorkbenchInitialState } from "../../src/renderer/src/components/review-workbench";
import { projection } from "./review-workbench-fixtures";

const { commits, revision, session } = projection();
const model = { commits, revision, session };

function openAt(initialState?: ReviewWorkbenchInitialState) {
  return renderHook(() =>
    useReviewWorkbenchPosition(
      initialState === undefined ? { model } : { model, initialState },
    ),
  );
}

afterEach(cleanup);

describe("useReviewWorkbenchPosition", () => {
  it("opens a Review with no saved position on Conversation", () => {
    expect(openAt().result.current.activeTab).toBe("conversation");
  });

  it("opens a local Review with no saved position on Diff, since it has no Conversation", () => {
    const local = {
      ...model,
      session: {
        ...session,
        key: {
          ...session.key,
          source: {
            kind: "local_branch" as const,
            branch: "main",
            baseRef: "refs/heads/develop",
          },
        },
      },
    };
    const { result } = renderHook(() =>
      useReviewWorkbenchPosition({ model: local }),
    );
    expect(result.current.activeTab).toBe("diff");
  });

  it.each([
    { activeTab: "conversation" },
    { activeTab: "diff" },
    { activeTab: "insights" },
  ] as const)(
    "reopens a Review on the saved $activeTab tab",
    ({ activeTab }) => {
      expect(
        openAt({ activeTab, section: "files" }).result.current.activeTab,
      ).toBe(activeTab);
    },
  );

  const localBranch = {
    kind: "local_branch" as const,
    branch: "feature",
    baseRef: "refs/heads/main",
  };
  it.each([
    {
      source: { kind: "commit" as const, commitSha: "a".repeat(40) },
      saved: "commits",
      opens: "files",
    },
    { source: localBranch, saved: "commits", opens: "commits" },
    { source: localBranch, saved: "threads", opens: "files" },
    { source: localBranch, saved: "notes", opens: "notes" },
    { source: session.key.source, saved: "notes", opens: "files" },
    { source: session.key.source, saved: "threads", opens: "threads" },
  ] as const)(
    "reopens a $source.kind Review saved on $saved on $opens",
    ({ source, saved, opens }) => {
      const reopened = {
        ...model,
        session: { ...session, key: { ...session.key, source } },
      };
      const { result } = renderHook(() =>
        useReviewWorkbenchPosition({
          model: reopened,
          initialState: { activeTab: "diff", section: saved },
        }),
      );
      expect(result.current.section).toBe(opens);
    },
  );

  it("opens on Insights when only an insights section was saved", () => {
    expect(openAt({ section: "insights" }).result.current.activeTab).toBe(
      "insights",
    );
  });
});
