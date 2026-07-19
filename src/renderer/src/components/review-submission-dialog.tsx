import { useEffect, useMemo, useState } from "react";
import { Send, TriangleAlert } from "lucide-react";

import type {
  GitHubReviewEvent,
  ReviewDraft,
} from "../../../domain/review-draft";
import type { ReviewFinding } from "../../../domain/review-result";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldContent, FieldLabel } from "@/components/ui/field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";

type DialogPhase =
  | { readonly _tag: "local" }
  | { readonly _tag: "pending"; readonly reviewId: string }
  | {
      readonly _tag: "submitted";
      readonly reviewId: string;
      readonly event: GitHubReviewEvent;
    };

/** Exact-saved-draft confirmation surface; callbacks retain main-process ownership. */
export function ReviewSubmissionDialog(props: {
  readonly draft: Pick<ReviewDraft, "state" | "summaryBody" | "comments"> & {
    readonly updatedAt?: string;
  };
  readonly findings: ReadonlyArray<Pick<ReviewFinding, "id" | "severity">>;
  readonly onCreatePending: () => Promise<{ readonly reviewId: string }>;
  readonly onSubmitPending: (
    event: GitHubReviewEvent,
    summaryBody: string,
  ) => Promise<{ readonly reviewId: string }>;
  readonly onPendingChange?: (pending: boolean) => void;
}): React.JSX.Element {
  const [phase, setPhase] = useState<DialogPhase>(() =>
    initialPhase(props.draft),
  );
  const [createOpen, setCreateOpen] = useState(false);
  const [submitOpen, setSubmitOpen] = useState(false);
  const [createAcknowledged, setCreateAcknowledged] = useState(false);
  const [submitAcknowledged, setSubmitAcknowledged] = useState(false);
  const [event, setEvent] = useState<GitHubReviewEvent>("COMMENT");
  const [writeError, setWriteError] = useState<string>();
  const [pending, setPending] = useState(false);
  const postable = useMemo(
    () =>
      props.draft.comments.filter(
        (comment) =>
          comment.include &&
          comment.postability === "postable" &&
          comment.body.trim().length > 0,
      ),
    [props.draft.comments],
  );
  const includesP0P1 = postable.some((comment) =>
    props.findings.some(
      (finding) =>
        finding.id === comment.findingId &&
        (finding.severity === "P0" || finding.severity === "P1"),
    ),
  );
  const writeErrorAlert =
    writeError === undefined ? null : (
      <Alert variant="destructive">
        <TriangleAlert />
        <AlertTitle>Review write failed</AlertTitle>
        <AlertDescription>{writeError}</AlertDescription>
      </Alert>
    );
  useEffect(() => {
    props.onPendingChange?.(pending);
  }, [pending, props.onPendingChange]);

  const create = async (): Promise<void> => {
    if (pending) return;
    setPending(true);
    setWriteError(undefined);
    try {
      const result = await props.onCreatePending();
      setPhase({ _tag: "pending", reviewId: result.reviewId });
      setCreateOpen(false);
    } catch {
      setWriteError(
        "GitHub rejected the pending review. Your saved local draft was preserved.",
      );
    } finally {
      setPending(false);
    }
  };
  const submit = async (): Promise<void> => {
    if (pending) return;
    setPending(true);
    setWriteError(undefined);
    try {
      const result = await props.onSubmitPending(
        event,
        props.draft.summaryBody,
      );
      setPhase({ _tag: "submitted", reviewId: result.reviewId, event });
      setSubmitOpen(false);
    } catch {
      setWriteError(
        "GitHub could not submit the pending review. Your saved local draft was preserved.",
      );
    } finally {
      setPending(false);
    }
  };

  if (phase._tag === "submitted")
    return (
      <p role="status" className="text-sm text-primary">
        Review {phase.reviewId} submitted as {phase.event}.
      </p>
    );
  return (
    <section aria-label="GitHub review submission">
      {phase._tag === "local" ? (
        <AlertDialog
          open={createOpen}
          onOpenChange={(open) => {
            if (!pending) setCreateOpen(open);
          }}
        >
          <AlertDialogTrigger asChild>
            <Button
              variant="outline"
              className="w-full"
              disabled={postable.length === 0}
            >
              <Send />
              Create pending review
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent aria-busy={pending}>
            <AlertDialogHeader>
              <AlertDialogTitle>Create pending review</AlertDialogTitle>
              <AlertDialogDescription>
                This creates one pending GitHub review from the exact saved
                local draft. It does not submit the review.
              </AlertDialogDescription>
            </AlertDialogHeader>
            {writeErrorAlert}
            <div className="space-y-3 text-sm">
              <div className="flex gap-2">
                <Badge variant="secondary">{postable.length} comments</Badge>
                {props.draft.updatedAt === undefined ? null : (
                  <Badge variant="outline">
                    Revision {props.draft.updatedAt}
                  </Badge>
                )}
              </div>
              {includesP0P1 ? (
                <Alert>
                  <TriangleAlert />
                  <AlertTitle>P0/P1 findings included</AlertTitle>
                  <AlertDescription>
                    Review every high-severity comment before continuing.
                  </AlertDescription>
                </Alert>
              ) : null}
              <ul className="max-h-52 space-y-2 overflow-auto">
                {postable.map((comment) => (
                  <li key={comment.findingId} className="rounded-md border p-3">
                    <strong>
                      {comment.path}:{comment.line}
                    </strong>
                    <p className="mt-1 text-muted-foreground">{comment.body}</p>
                  </li>
                ))}
              </ul>
              <Field orientation="horizontal" className="items-start gap-2">
                <Checkbox
                  id="create-review-ack"
                  checked={createAcknowledged}
                  onCheckedChange={(checked) =>
                    setCreateAcknowledged(checked === true)
                  }
                />
                <FieldContent>
                  <FieldLabel htmlFor="create-review-ack" className="leading-5">
                    I understand this creates one pending GitHub review.
                  </FieldLabel>
                </FieldContent>
              </Field>
            </div>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
              <AlertDialogAction
                disabled={!createAcknowledged || pending}
                onClick={(event) => {
                  event.preventDefault();
                  void create();
                }}
              >
                {pending ? <Spinner /> : null}
                {pending ? "Creating…" : "Confirm pending review"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      ) : (
        <div>
          <p className="mb-3 text-sm text-primary">
            Pending review {phase.reviewId} created.
          </p>
          <AlertDialog
            open={submitOpen}
            onOpenChange={(open) => {
              if (!pending) setSubmitOpen(open);
            }}
          >
            <AlertDialogTrigger asChild>
              <Button className="w-full">Submit pending review</Button>
            </AlertDialogTrigger>
            <AlertDialogContent aria-busy={pending}>
              <AlertDialogHeader>
                <AlertDialogTitle>Submit pending review</AlertDialogTitle>
                <AlertDialogDescription>
                  Submit the existing pending review using the exact saved
                  summary and selected event.
                </AlertDialogDescription>
              </AlertDialogHeader>
              {writeErrorAlert}
              <div className="space-y-4">
                <Field>
                  <FieldLabel htmlFor="review-event">Review event</FieldLabel>
                  <Select
                    value={event}
                    onValueChange={(value) =>
                      setEvent(value as GitHubReviewEvent)
                    }
                  >
                    <SelectTrigger id="review-event" className="mt-1.5">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="COMMENT">COMMENT</SelectItem>
                      <SelectItem value="APPROVE">APPROVE</SelectItem>
                      <SelectItem value="REQUEST_CHANGES">
                        REQUEST_CHANGES
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
                <div className="rounded-md border bg-muted p-3 text-sm">
                  <p className="font-medium">Saved review summary</p>
                  <p className="mt-1 text-muted-foreground">
                    {props.draft.summaryBody}
                  </p>
                </div>
                <Field orientation="horizontal" className="items-start gap-2">
                  <Checkbox
                    id="submit-review-ack"
                    checked={submitAcknowledged}
                    onCheckedChange={(checked) =>
                      setSubmitAcknowledged(checked === true)
                    }
                  />
                  <FieldContent>
                    <FieldLabel htmlFor="submit-review-ack" className="leading-5">
                      I understand this submits the pending review.
                    </FieldLabel>
                  </FieldContent>
                </Field>
              </div>
              <AlertDialogFooter>
                <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  disabled={!submitAcknowledged || pending}
                  onClick={(action) => {
                    action.preventDefault();
                    void submit();
                  }}
                >
                  {pending ? <Spinner /> : null}
                  {pending ? "Submitting…" : "Submit review"}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      )}
    </section>
  );
}

function initialPhase(draft: Pick<ReviewDraft, "state">): DialogPhase {
  if (draft.state._tag === "PendingGitHubReview")
    return { _tag: "pending", reviewId: draft.state.pendingReviewId };
  if (draft.state._tag === "SubmittedGitHubReview")
    return {
      _tag: "submitted",
      reviewId: draft.state.reviewId,
      event: draft.state.event,
    };
  return { _tag: "local" };
}
