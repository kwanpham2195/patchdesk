import { describe, expect, it } from "vitest";

import { reviewContextControl } from "../../src/renderer/src/review-context-control";

describe("reviewContextControl", () => {
  it("only enables unchanged-context controls when a rendered diff can expand", () => {
    expect(
      reviewContextControl({
        hasSourceSession: true,
        status: "ready",
        hasExpandableRenderedFile: true,
        expanded: false,
      }),
    ).toEqual({
      disabled: false,
      label: "Context",
      description: "Expand unchanged context",
    });
  });

  it("explains loading and unavailable source states instead of exposing a no-op", () => {
    expect(
      reviewContextControl({
        hasSourceSession: true,
        status: "loading",
        hasExpandableRenderedFile: false,
        expanded: false,
      }),
    ).toMatchObject({ disabled: true, label: "Loading context" });
    expect(
      reviewContextControl({
        hasSourceSession: false,
        status: "idle",
        hasExpandableRenderedFile: false,
        expanded: false,
      }),
    ).toEqual({
      disabled: true,
      label: "Context unavailable",
      description: "Exact file contents are unavailable for this review",
    });
  });
});
