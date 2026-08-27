import { useState } from "react";
import { GitMerge, ShieldAlert } from "lucide-react";

import type { MergeDisplayReason } from "../../../domain/github-context";
import type { PullRequestRef } from "../../../domain/pull-request";
import type { MergeReadiness } from "../../../domain/merge-readiness";
import {
  openPullRequestExternalUrl,
  pullRequestPageUrl,
} from "../external-links";
import { PatchdeskApiError } from "../api-client";
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

export type MergeMethod = "merge" | "squash" | "rebase";

type MergeContext = {
  readonly repo: string;
  readonly prNumber: number;
  readonly title: string;
  readonly base: string;
  readonly head: string;
  readonly headSha: string;
};

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
  ) => Promise<{ readonly mergeCommitSha?: string }>;
  readonly onRecoverMerge?: () => Promise<void>;
}): React.JSX.Element {
  const [method, setMethod] = useState<MergeMethod>(
    props.initialMethod ?? props.methods[0] ?? "squash",
  );
  const [acknowledged, setAcknowledged] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const [merged, setMerged] = useState<string>();
  const [recovering, setRecovering] = useState(false);

  const merge = async (): Promise<void> => {
    if (pending) return;
    setPending(true);
    setError(undefined);
    try {
      const result = await props.onMerge(
        method,
        acknowledged ? props.readiness.warnings : [],
      );
      setMerged(result.mergeCommitSha ?? "pull request");
    } catch (cause) {
      setError(
        cause instanceof PatchdeskApiError && cause.kind === "merge_in_progress"
          ? cause.message
          : "GitHub did not confirm the merge. Restart Patchdesk to run recovery before you try again.",
      );
    } finally {
      setPending(false);
    }
  };
  const recover = async (): Promise<void> => {
    if (recovering || pending || props.onRecoverMerge === undefined) return;
    setRecovering(true);
    setError(undefined);
    try {
      await props.onRecoverMerge();
    } catch {
      setError(
        "GitHub still cannot confirm the merge. Check GitHub status again later; Patchdesk will not retry the merge.",
      );
    } finally {
      setRecovering(false);
    }
  };

  if (merged !== undefined)
    return (
      <p role="status" className="text-sm text-primary">
        Merged {merged}.
      </p>
    );
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
      className="flex flex-col gap-3 rounded-lg border bg-muted/40 p-3 sm:flex-row sm:items-center sm:justify-between"
    >
      <p className="min-w-0 text-xs text-muted-foreground">
        {props.context.repo}#{props.context.prNumber} · {props.context.base} ←{" "}
        {props.context.head} · <code>{props.context.headSha.slice(0, 8)}</code>
      </p>
      {error === undefined ? null : (
        <Alert variant="destructive">
          <AlertTitle>Merge not confirmed</AlertTitle>
          <AlertDescription>
            <p>{error}</p>
            {props.onRecoverMerge === undefined ? null : (
              <Button
                className="mt-2"
                variant="outline"
                disabled={recovering || pending}
                onClick={() => void recover()}
              >
                {recovering ? "Checking GitHub…" : "Check GitHub status"}
              </Button>
            )}
          </AlertDescription>
        </Alert>
      )}
      {needsAcknowledgement ? (
        <div className="flex items-start gap-2">
          <Checkbox
            id="merge-ack"
            checked={acknowledged}
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
      <div className="flex flex-wrap items-center gap-2">
        <label className="text-sm font-medium" htmlFor="merge-method">
          Merge method
        </label>
        <ButtonGroup aria-label="Merge action">
          <Select
            value={method}
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
            <GitMerge data-icon="inline-start" />
            {pending ? "Merging…" : "Merge"}
          </Button>
        </ButtonGroup>
      </div>
    </section>
  );
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
