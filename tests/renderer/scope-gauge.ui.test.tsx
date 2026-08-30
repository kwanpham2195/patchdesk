// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import type { ChangeScope } from "../../src/domain/change-scope";
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
