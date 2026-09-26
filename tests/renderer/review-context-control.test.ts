import { describe, expect, it } from "vitest";

import { reviewContextControl } from "../../src/renderer/src/review-context-control";

describe("reviewContextControl", () => {
  it("only enables unchanged-context controls when a rendered diff can expand", () => {
    expect(
      reviewContextControl({
        hasSourceSession: true,
        status: "ready",
        renderedContext: "expandable",
        expanded: false,
      }),
    ).toEqual({
      disabled: false,
      label: "Context",
      description: "Expand unchanged context",
    });
  });

  it("explains why context is disabled while source contents load", () => {
    expect(
      reviewContextControl({
        hasSourceSession: true,
        status: "loading",
        renderedContext: "unknown",
        expanded: false,
      }),
    ).toMatchObject({ disabled: true, label: "Loading context" });
  });

  it("explains when no source session is available instead of exposing a no-op", () => {
    expect(
      reviewContextControl({
        hasSourceSession: false,
        status: "idle",
        renderedContext: "unknown",
        expanded: false,
      }),
    ).toEqual({
      disabled: true,
      label: "Context unavailable",
      description: "Exact file contents are unavailable for this review",
    });
  });

  it("explains when required contents cannot be read from saved revisions", () => {
    expect(
      reviewContextControl({
        hasSourceSession: true,
        status: "unavailable",
        renderedContext: "unknown",
        expanded: false,
        unavailableReason: "github_read",
      }),
    ).toEqual({
      disabled: true,
      label: "Context unavailable",
      description:
        "Patchdesk could not load unchanged context from the saved review revisions",
    });
  });

  it("keeps Context disabled without calling it unavailable when every shown file is added or deleted", () => {
    expect(
      reviewContextControl({
        hasSourceSession: true,
        status: "ready",
        renderedContext: "nothing_to_expand",
        expanded: false,
      }),
    ).toMatchObject({ disabled: true, label: "Context" });
  });
});
