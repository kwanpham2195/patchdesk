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
  readonly unavailableReason?: string | undefined;
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
      ? unavailableContextDescription(input.unavailableReason)
      : "Exact file contents are unavailable for this review",
  };
}

function unavailableContextDescription(reason: string | undefined): string {
  switch (reason) {
    case "github_read":
      return "Patchdesk could not read the required file contents from the saved review revisions";
    case "binary":
      return "Unchanged context is unavailable for binary files";
    case "too_large":
      return "The file is too large to load unchanged context";
    case "revision_unavailable":
      return "The saved review does not include the revisions required for unchanged context";
    case "head_changed":
      return "The pull request head changed after this review was prepared";
    case "patch_unavailable":
      return "The saved patch does not match the required file contents";
    case "path_unavailable":
      return "The selected path is unavailable in the saved review";
    default:
      return "Exact file contents are unavailable for the rendered diff";
  }
}
