// @vitest-environment jsdom
import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { useReviewWorkbenchPosition } from "../../src/renderer/src/hooks/use-review-workbench-position";
import type { ReviewWorkbenchInitialState } from "../../src/renderer/src/components/review-workbench";
import { projection } from "./review-workbench-fixtures";

const { commits, revision } = projection();
const model = { commits, revision };

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

  it("opens on Insights when only an insights section was saved", () => {
    expect(openAt({ section: "insights" }).result.current.activeTab).toBe(
      "insights",
    );
  });
});
