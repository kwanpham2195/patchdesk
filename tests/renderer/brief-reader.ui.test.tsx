// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { changeScopeFromPatch } from "../../src/domain/change-scope";
import {
  briefCitationChipLabel,
  briefCitationStatusLine,
} from "../../src/renderer/src/brief-contracts";
import { BriefReader } from "../../src/renderer/src/components/brief-reader";
import { briefInsight, briefValue } from "./review-workbench-fixtures";

const retained = () => {
  const projection = briefInsight();
  if (projection.retained === undefined)
    throw new Error("the Brief fixture retains a value");
  return projection.retained;
};

const retainedWithDrift = () => {
  const base = retained();
  return {
    ...base,
    value: {
      ...briefValue,
      descriptionDrift: {
        claimed: [
          {
            quote: "Replies also reconcile after the write.",
            note: "No reply path changes in the diff.",
            citations: briefValue.goal[0]?.citations.slice(0, 1) ?? [],
          },
        ],
        undescribed: [
          {
            text: "Three services now pass the session into the write gate.",
            citations: briefValue.goal[0]?.citations.slice(1, 2) ?? [],
          },
        ],
      },
    },
  };
};

afterEach(() => cleanup());

describe("BriefReader", () => {
  it("renders one retained Brief and regenerates on request", async () => {
    const onRegenerate = vi.fn();
    const user = userEvent.setup();
    render(
      <BriefReader
        retained={retained()}
        scope={changeScopeFromPatch(
          "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n",
        )}
        onRegenerate={onRegenerate}
      />,
    );

    expect(screen.getByRole("region", { name: "Goal" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Assumptions" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Provenance" })).toBeTruthy();
    expect(screen.getByRole("img", { name: /^Scope:/ })).toBeTruthy();
    expect(
      screen.queryByRole("region", { name: "Description vs diff" }),
    ).toBeNull();

    await user.click(screen.getByRole("button", { name: "Regenerate" }));
    expect(onRegenerate).toHaveBeenCalledTimes(1);
  });

  it("renders both drift regions when the Brief compared the description", () => {
    render(
      <BriefReader
        retained={retainedWithDrift()}
        onRegenerate={() => undefined}
      />,
    );

    expect(
      screen.getByRole("region", { name: "Description vs diff" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("region", { name: "Claimed, not in the diff" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("region", { name: "In the diff, not described" }),
    ).toBeTruthy();
  });

  it("disables regeneration when no run may start", () => {
    render(
      <BriefReader
        retained={retained()}
        onRegenerate={() => undefined}
        regenerateDisabled
      />,
    );

    expect(
      screen
        .getByRole("button", { name: "Regenerate" })
        .hasAttribute("disabled"),
    ).toBe(true);
  });
});

describe("brief citation labels", () => {
  it("names each evidence kind by its shortest identifier", () => {
    const [description, hunk, commit] = briefValue.goal[0]?.citations ?? [];
    expect(description && briefCitationChipLabel(description)).toBe("desc ¶1");
    expect(hunk && briefCitationChipLabel(hunk)).toBe("src/a.ts");
    expect(commit && briefCitationChipLabel(commit)).toBe("c6d5d41");
  });

  it("counts resolved citations against assumptions", () => {
    expect(briefCitationStatusLine(briefValue)).toBe(
      "3 verified · 1 assumption",
    );
  });
});
