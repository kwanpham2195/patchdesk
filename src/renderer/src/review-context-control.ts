export type ReviewContextStatus = "idle" | "loading" | "ready" | "unavailable";

export type ReviewContextControl = {
  readonly disabled: boolean;
  readonly label: "Context" | "Loading context" | "Context unavailable";
  readonly description: string;
};

/**
 * A raw unified patch can show collapsed separators, but only a hydrated
 * Pierre diff has the exact blobs required to expand them. Keep the toolbar
 * honest: a disabled control explains why rather than offering a no-op.
 */
export function reviewContextControl(input: {
  readonly hasSourceSession: boolean;
  readonly status: ReviewContextStatus;
  readonly hasExpandableRenderedFile: boolean;
  readonly expanded: boolean;
}): ReviewContextControl {
  if (input.hasExpandableRenderedFile) {
    return {
      disabled: false,
      label: "Context",
      description: input.expanded
        ? "Collapse unchanged context"
        : "Expand unchanged context",
    };
  }
  if (input.status === "loading") {
    return {
      disabled: true,
      label: "Loading context",
      description: "Loading exact file contents for unchanged context",
    };
  }
  return {
    disabled: true,
    label: "Context unavailable",
    description: input.hasSourceSession
      ? "Exact file contents are unavailable for the rendered diff"
      : "Exact file contents are unavailable for this review",
  };
}
