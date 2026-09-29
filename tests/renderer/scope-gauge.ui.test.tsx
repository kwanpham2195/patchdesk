// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import type {
  ChangeScope,
  ChangeScopeBucket,
} from "../../src/domain/change-scope";
import { ScopeGauge } from "../../src/renderer/src/components/scope-gauge";

afterEach(() => {
  cleanup();
});

const scope: ChangeScope = {
  buckets: [
    { bucket: "core", files: 2, additions: 15, deletions: 3 },
    { bucket: "tests", files: 1, additions: 20, deletions: 0 },
    { bucket: "generated", files: 1, additions: 300, deletions: 100 },
  ],
  total: { files: 4, additions: 335, deletions: 103 },
};

describe("ScopeGauge", () => {
  it("names every bucket in the bar's accessible label at both sizes", () => {
    const { rerender } = render(<ScopeGauge scope={scope} size="mini" />);
    expect(screen.getByRole("img", { name: /Core/ })).toBeInstanceOf(
      HTMLElement,
    );
    rerender(<ScopeGauge scope={scope} size="card" />);
    const bar = screen.getByRole("img", { name: /Generated/ });
    expect(bar.getAttribute("aria-label")).toContain("Tests");
  });

  it("lists only the buckets with files at the legend size", () => {
    render(<ScopeGauge scope={scope} size="legend" />);
    expect(
      screen.getAllByRole("listitem").map((item) => item.textContent),
    ).toEqual(["Core2", "Tests1", "Generated1"]);
  });

  it("makes each card row with files a button that selects its bucket, and leaves an empty row as text", async () => {
    const selected: Array<ChangeScopeBucket> = [];
    render(
      <ScopeGauge
        scope={scope}
        size="card"
        onBucketSelect={(bucket) => selected.push(bucket)}
      />,
    );

    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Filter the Diff to Tests" }));

    expect(selected).toEqual(["tests"]);
    expect(screen.getAllByRole("button")).toHaveLength(3);
    for (const empty of ["Docs", "Config"])
      expect(
        screen.queryByRole("button", { name: `Filter the Diff to ${empty}` }),
      ).toBeNull();
  });

  it("draws one segment per bucket and none for an empty scope", () => {
    render(<ScopeGauge scope={scope} size="card" />);
    expect(screen.getByRole("img").childElementCount).toBe(3);
    cleanup();
    render(
      <ScopeGauge
        scope={{ buckets: [], total: { files: 0, additions: 0, deletions: 0 } }}
        size="card"
      />,
    );
    expect(screen.getByRole("img").childElementCount).toBe(0);
  });
});
