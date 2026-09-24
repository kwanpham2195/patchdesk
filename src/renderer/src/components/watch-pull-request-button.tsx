import { Eye, EyeOff } from "lucide-react";

import {
  useWatchedPullRequests,
  type WatchToggleFailure,
  type WatchedPullRequestRef,
} from "@/hooks/use-watched-pull-requests";
import { Button } from "@/components/ui/button";
import { InlineError } from "@/components/ui/inline-error";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

/** The sentence a refused Watch or Unwatch shows beside its toggle. */
function watchToggleFailureCopy(failure: WatchToggleFailure): string {
  switch (failure.kind) {
    case "limit":
      return `Watch limit reached: ${failure.limit} per workspace.`;
    case "terminal":
      return `${failure.state === "merged" ? "Merged" : "Closed"} pull requests cannot be watched.`;
    case "failed":
      return "Could not change whether this pull request is watched.";
  }
}

/** Inline explanation for a refused Watch or Unwatch action. */
export function WatchToggleFailureMessage({
  failure,
}: {
  readonly failure: WatchToggleFailure;
}): React.JSX.Element {
  return (
    <span className="text-xs text-destructive">
      {watchToggleFailureCopy(failure)}
    </span>
  );
}

/**
 * Watch / Unwatch for one pull request (ADR 0045). Renders nothing outside a
 * loaded workspace, so a surface can place it without checking.
 */
export function WatchPullRequestButton({
  pullRequest,
  size = "sm",
  className,
  showFailure = true,
  onTerminalRefusal,
}: {
  readonly pullRequest: WatchedPullRequestRef;
  readonly size?: "xs" | "sm";
  readonly className?: string;
  /** False when the surface renders `WatchPullRequestFailure` elsewhere. */
  readonly showFailure?: boolean;
  /** Called when GitHub reports the pull request merged or closed. */
  readonly onTerminalRefusal?: () => void;
}): React.JSX.Element | null {
  const watch = useWatchedPullRequests();
  if (watch === undefined) return null;
  const watched = watch.isWatched(pullRequest);
  const pending = watch.isPending(pullRequest);
  return (
    <>
      <Button
        variant="outline"
        size={size}
        className={className}
        disabled={pending}
        onClick={() =>
          void watch.toggle(pullRequest).then((failure) => {
            if (failure?.kind === "terminal") onTerminalRefusal?.();
          })
        }
      >
        {pending ? (
          <Spinner data-icon="inline-start" />
        ) : watched ? (
          <EyeOff data-icon="inline-start" />
        ) : (
          <Eye data-icon="inline-start" />
        )}
        {watched ? "Unwatch" : "Watch"}
      </Button>
      {showFailure ? (
        <WatchPullRequestFailure
          pullRequest={pullRequest}
          className="basis-full"
        />
      ) : null}
    </>
  );
}

/** The last refused Watch or Unwatch of one pull request, if any. */
export function WatchPullRequestFailure({
  pullRequest,
  className,
}: {
  readonly pullRequest: WatchedPullRequestRef;
  readonly className?: string;
}): React.JSX.Element | null {
  const failure = useWatchedPullRequests()?.failureFor(pullRequest);
  if (failure === undefined) return null;
  return (
    <InlineError className={cn("text-xs", className)}>
      {watchToggleFailureCopy(failure)}
    </InlineError>
  );
}
