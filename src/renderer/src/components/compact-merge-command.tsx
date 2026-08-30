import { useRef, useState } from "react";
import { GitMerge, ShieldAlert } from "lucide-react";

import type { MergeDisplayReason } from "../../../domain/github-context";
import type { MergeReadiness } from "../../../domain/merge-readiness";
import type { PullRequestRef } from "../../../domain/pull-request";
import { PatchdeskApiError } from "../api-client";
import {
  openPullRequestExternalUrl,
  pullRequestPageUrl,
} from "../external-links";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";

export type MergeMethod = "merge" | "squash" | "rebase";

/** Confirmation returned after the merge receipt is committed locally. */
export type MergeCommandResult = {
  readonly state: "confirmed" | "confirmed_refresh_required";
  readonly mergeCommitSha?: string;
};

type MergeContext = {
  readonly repo: string;
  readonly prNumber: number;
  readonly title: string;
  readonly base: string;
  readonly head: string;
  readonly headSha: string;
};

type MergeOutcome =
  | { readonly state: "idle" }
  | { readonly state: "retryable_error"; readonly message: string }
  | { readonly state: "recovery_required"; readonly message: string }
  | ({ readonly state: "confirmed" | "confirmed_refresh_required" } & {
      readonly mergeCommitSha?: string;
    });

/** Compact, explicit merge command with revision-bound warning acknowledgement. */
export function CompactMergeCommand(props: {
  readonly readiness: MergeReadiness;
  readonly mergeReasons?: ReadonlyArray<MergeDisplayReason>;
  readonly pullRequest?: PullRequestRef;
  readonly context: MergeContext;
  readonly methods: ReadonlyArray<MergeMethod>;
  readonly initialMethod?: MergeMethod;
  readonly onMerge: (
    method: MergeMethod,
    warningCodes: ReadonlyArray<string>,
  ) => Promise<MergeCommandResult>;
  readonly onRecoverMerge?: () => Promise<void>;
}): React.JSX.Element {
  const [method, setMethod] = useState<MergeMethod>(
    props.initialMethod ?? props.methods[0] ?? "squash",
  );
  const [acknowledged, setAcknowledged] = useState(false);
  const [pending, setPending] = useState(false);
  const [outcome, setOutcome] = useState<MergeOutcome>({ state: "idle" });
  const [recovering, setRecovering] = useState(false);
  const pendingRef = useRef(false);
  const recoveringRef = useRef(false);

  const merge = async (): Promise<void> => {
    if (
      pendingRef.current ||
      recoveringRef.current ||
      outcome.state === "recovery_required" ||
      outcome.state === "confirmed" ||
      outcome.state === "confirmed_refresh_required"
    )
      return;
    pendingRef.current = true;
    setPending(true);
    setOutcome({ state: "idle" });
    try {
      const result = await props.onMerge(
        method,
        acknowledged ? props.readiness.warnings : [],
      );
      setOutcome(confirmedOutcome(result.state, result.mergeCommitSha));
    } catch (cause: unknown) {
      setOutcome(
        cause instanceof PatchdeskApiError && cause.kind === "merge_in_progress"
          ? { state: "retryable_error", message: cause.message }
          : {
              state: "recovery_required",
              message:
                "GitHub did not confirm the merge. Check GitHub status before another merge; Patchdesk will not retry it.",
            },
      );
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  };

  const recover = async (): Promise<void> => {
    if (
      recoveringRef.current ||
      pendingRef.current ||
      props.onRecoverMerge === undefined
    )
      return;
    recoveringRef.current = true;
    setRecovering(true);
    try {
      await props.onRecoverMerge();
      if (outcome.state === "confirmed_refresh_required") {
        setOutcome(confirmedOutcome("confirmed", outcome.mergeCommitSha));
      } else if (outcome.state === "recovery_required") {
        setOutcome({ state: "idle" });
      }
    } catch {
      if (outcome.state === "recovery_required") {
        setOutcome({
          state: "recovery_required",
          message:
            "GitHub still cannot confirm the merge. Check GitHub status again later; Patchdesk will not retry the merge.",
        });
      }
    } finally {
      recoveringRef.current = false;
      setRecovering(false);
    }
  };

  if (
    outcome.state === "confirmed" ||
    outcome.state === "confirmed_refresh_required"
  ) {
    return (
      <section aria-label="Merge result" className="flex flex-col gap-2">
        <p role="status" aria-label="Merged" className="text-sm text-primary">
          Merged {outcome.mergeCommitSha ?? "pull request"}.
        </p>
        {outcome.state === "confirmed_refresh_required" ? (
          <Alert>
            <AlertTitle>Merge confirmed; refresh required</AlertTitle>
            <AlertDescription>
              <p>
                GitHub confirmed the merge, but Patchdesk could not refresh the
                Review projection.
              </p>
              {props.onRecoverMerge === undefined ? null : (
                <Button
                  className="mt-2"
                  variant="outline"
                  disabled={recovering}
                  onClick={() => void recover()}
                >
                  {recovering ? (
                    <Spinner aria-hidden="true" data-icon="inline-start" />
                  ) : null}
                  {recovering ? "Checking…" : "Check GitHub status"}
                </Button>
              )}
            </AlertDescription>
          </Alert>
        ) : null}
      </section>
    );
  }

  if (outcome.state === "recovery_required") {
    return (
      <Alert variant="destructive">
        <AlertTitle>Merge not confirmed</AlertTitle>
        <AlertDescription>
          <p>{outcome.message}</p>
          {props.onRecoverMerge === undefined ? null : (
            <Button
              className="mt-2"
              variant="outline"
              disabled={recovering}
              onClick={() => void recover()}
            >
              {recovering ? (
                <Spinner aria-hidden="true" data-icon="inline-start" />
              ) : null}
              {recovering ? "Checking…" : "Check GitHub status"}
            </Button>
          )}
        </AlertDescription>
      </Alert>
    );
  }

  if (props.readiness._tag === "Blocked") {
    return (
      <Alert variant="destructive" aria-label="Merge readiness">
        <ShieldAlert />
        <AlertTitle>Merge blocked</AlertTitle>
        <AlertDescription>
          <ul className="mt-1 list-disc pl-5">
            {props.mergeReasons?.length
              ? props.mergeReasons.map((reason) => (
                  <li key={`${reason.code}-${reason.source}-${reason.message}`}>
                    {reason.message}
                    {reason.openOnGitHub && props.pullRequest !== undefined ? (
                      <Button
                        variant="link"
                        size="sm"
                        className="ml-1 h-auto p-0 align-baseline"
                        onClick={() => {
                          if (props.pullRequest !== undefined)
                            void openPullRequestExternalUrl(
                              pullRequestPageUrl(props.pullRequest).toString(),
                              props.pullRequest,
                            );
                        }}
                      >
                        Open on GitHub
                      </Button>
                    ) : null}
                  </li>
                ))
              : props.readiness.blockers.map((blocker) => (
                  <li key={blocker}>{mergeBlockerLabel(blocker)}</li>
                ))}
          </ul>
        </AlertDescription>
      </Alert>
    );
  }
  const needsAcknowledgement = props.readiness._tag === "NeedsAcknowledgement";
  return (
    <section
      aria-label="Merge command"
      className="@container/merge-command rounded-lg border bg-muted/40 p-3"
    >
      <div className="flex min-w-0 flex-col gap-3 @2xl/merge-command:flex-row @2xl/merge-command:items-center @2xl/merge-command:justify-between">
        <p className="w-full min-w-0 break-words text-xs text-muted-foreground @2xl/merge-command:flex-1">
          {props.context.repo}#{props.context.prNumber} · {props.context.base} ←{" "}
          {props.context.head} ·{" "}
          <code>{props.context.headSha.slice(0, 8)}</code>
        </p>
        {outcome.state === "retryable_error" ? (
          <Alert variant="destructive" className="w-full min-w-0">
            <AlertTitle>Merge not submitted</AlertTitle>
            <AlertDescription>{outcome.message}</AlertDescription>
          </Alert>
        ) : null}
        {/* `w-full` is the stacked width. Without the `@2xl` override the
            acknowledgement keeps a 100% flex base in the row, which leaves no
            space for the `flex-1` context line (base 0, so it never shrinks)
            and collapses it, and everything below it, to width 0. */}
        {needsAcknowledgement ? (
          <div className="flex w-full min-w-0 items-start gap-2 @2xl/merge-command:w-auto">
            <Checkbox
              id="merge-ack"
              checked={acknowledged}
              disabled={pending || recovering}
              onCheckedChange={(checked) => setAcknowledged(checked === true)}
            />
            <Label htmlFor="merge-ack" className="leading-5">
              I acknowledge:{" "}
              {props.readiness.warnings
                .map((warning) => warning.replaceAll("_", " "))
                .join(", ")}
              .
            </Label>
          </div>
        ) : null}
        <div className="flex w-full min-w-0 flex-wrap items-center gap-2 @2xl/merge-command:w-auto @2xl/merge-command:shrink-0">
          <label className="text-sm font-medium" htmlFor="merge-method">
            Merge method
          </label>
          <ButtonGroup aria-label="Merge action">
            <Select
              value={method}
              disabled={pending || recovering}
              items={props.methods.map((candidate) => ({
                label: candidate,
                value: candidate,
              }))}
              onValueChange={(value) => {
                // SAFETY: The catalog is built only from MergeMethod values.
                setMethod(value as MergeMethod);
              }}
            >
              <SelectTrigger id="merge-method">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {props.methods.map((candidate) => (
                    <SelectItem key={candidate} value={candidate}>
                      {candidate}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
            <Button
              onClick={() => void merge()}
              disabled={pending || (needsAcknowledgement && !acknowledged)}
            >
              {pending ? (
                <Spinner aria-hidden="true" data-icon="inline-start" />
              ) : (
                <GitMerge data-icon="inline-start" />
              )}
              {pending ? "Merging…" : "Merge"}
            </Button>
          </ButtonGroup>
        </div>
      </div>
    </section>
  );
}

function confirmedOutcome(
  state: "confirmed" | "confirmed_refresh_required",
  mergeCommitSha: string | undefined,
): MergeOutcome {
  return mergeCommitSha === undefined ? { state } : { state, mergeCommitSha };
}

function mergeBlockerLabel(
  blocker: MergeReadiness["blockers"][number],
): string {
  switch (blocker) {
    case "conflicting":
      return "conflicting changes";
    case "merge_blocked":
      return "blocked by GitHub";
    case "mergeability_unknown":
      return "GitHub merge status unavailable";
    case "github_review":
      return "approval required";
    default:
      return blocker.replaceAll("_", " ");
  }
}
