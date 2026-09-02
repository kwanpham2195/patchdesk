import { Ban, CheckCircle2, MessageCircle, XCircle } from "lucide-react";

import type { ReviewVerdictState } from "../../../domain/review-verdicts";

/** Shared so the Reviewers rail and the Pull requests review-state filter draw one glyph per verdict, and always `aria-hidden` because every place that draws one also writes the verdict out in words. */
export function ReviewVerdictIcon({
  verdict,
  className = "size-3",
}: {
  readonly verdict: ReviewVerdictState;
  readonly className?: string;
}): React.JSX.Element {
  switch (verdict) {
    case "approved":
      return <CheckCircle2 className={className} aria-hidden="true" />;
    case "changes_requested":
      return <XCircle className={className} aria-hidden="true" />;
    case "commented":
      return <MessageCircle className={className} aria-hidden="true" />;
    case "dismissed":
      return <Ban className={className} aria-hidden="true" />;
  }
}
