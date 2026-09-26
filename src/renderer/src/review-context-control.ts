import { casesHandled } from "../../domain/result";
import type { ReviewDiffUnavailableReason } from "./hooks/use-review-diff-hydration";

export type ReviewContextStatus = "idle" | "loading" | "ready" | "unavailable";

export type ReviewContextControl = {
  readonly disabled: boolean;
  readonly label: "Context" | "Loading context" | "Context unavailable";
  readonly description: string;
};

/**
 * What the rendered files offer to expand: a hydrated file with both sides,
 * nothing (no files, or only added and deleted files, which have no unchanged
 * lines), or not yet known.
 */
export type RenderedContext = "expandable" | "nothing_to_expand" | "unknown";

/**
 * A raw unified patch can show collapsed separators, but only a hydrated
 * Pierre diff has the exact blobs required to expand them. Keep the toolbar
 * honest: a disabled control explains why rather than offering a no-op.
 */
export function reviewContextControl(input: {
  readonly hasSourceSession: boolean;
  readonly status: ReviewContextStatus;
  readonly renderedContext: RenderedContext;
  readonly expanded: boolean;
  readonly unavailableReason?: ReviewDiffUnavailableReason | undefined;
}): ReviewContextControl {
  if (input.renderedContext === "expandable") {
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
  // Contents loaded, but added and deleted files have no unchanged lines, so
  // "unavailable" would misreport a complete snapshot.
  if (
    input.renderedContext === "nothing_to_expand" &&
    input.unavailableReason === undefined
  ) {
    return {
      disabled: true,
      label: "Context",
      description: "The shown files have no unchanged lines to expand",
    };
  }
  return {
    disabled: true,
    label: "Context unavailable",
    description: !input.hasSourceSession
      ? "Exact file contents are unavailable for this review"
      : input.unavailableReason === undefined
        ? "Exact file contents are unavailable for the rendered diff"
        : unavailableContextDescription(input.unavailableReason),
  };
}

function unavailableContextDescription(
  reason: ReviewDiffUnavailableReason,
): string {
  switch (reason) {
    case "github_read":
      return "Patchdesk could not load unchanged context from the saved review revisions";
    case "binary":
      return "Unchanged context is unavailable for binary files";
    case "too_large":
      return "The file is too large to load unchanged context";
    case "revision_unavailable":
      return "The saved review does not include the revisions required for unchanged context";
    case "head_changed":
      return "The head changed after this review was prepared";
    case "patch_unavailable":
      return "The saved patch does not match the required file contents";
    case "path_unavailable":
      return "The selected path is unavailable in the saved review";
    default:
      return casesHandled(reason);
  }
}
