import { useMemo, useState } from "react";

import type { GitHubReviewEvent, ReviewDraft } from "../../../domain/review-draft";
import type { ReviewFinding } from "../../../domain/review-result";

type DialogPhase =
  | { readonly _tag: "local" }
  | { readonly _tag: "pending"; readonly reviewId: string }
  | { readonly _tag: "submitted"; readonly reviewId: string; readonly event: GitHubReviewEvent };

/** Confirmation-only renderer surface; main-process callers own the actual GitHub write service. */
export function ReviewSubmissionDialog(props: {
  readonly draft: Pick<ReviewDraft, "state" | "summaryBody" | "comments">;
  readonly findings: ReadonlyArray<Pick<ReviewFinding, "id" | "severity">>;
  readonly onCreatePending: () => Promise<{ readonly reviewId: string }>;
  readonly onSubmitPending: (event: GitHubReviewEvent, summaryBody: string) => Promise<{ readonly reviewId: string }>;
}): React.JSX.Element {
  const [phase, setPhase] = useState<DialogPhase>(() => initialPhase(props.draft));
  const [dialog, setDialog] = useState<"create" | "submit" | undefined>();
  const [createAcknowledged, setCreateAcknowledged] = useState(false);
  const [submitAcknowledged, setSubmitAcknowledged] = useState(false);
  const [event, setEvent] = useState<GitHubReviewEvent>("COMMENT");
  const [summaryBody, setSummaryBody] = useState(props.draft.summaryBody);
  const [writeError, setWriteError] = useState<string | undefined>();
  const postable = useMemo(
    () => props.draft.comments.filter((comment) => comment.include && comment.postability === "postable" && comment.body.trim().length > 0),
    [props.draft.comments],
  );
  const includesP0P1 = postable.some((comment) => props.findings.some((finding) => finding.id === comment.findingId && (finding.severity === "P0" || finding.severity === "P1")));

  const create = async (): Promise<void> => {
    try {
      const pending = await props.onCreatePending();
      setPhase({ _tag: "pending", reviewId: pending.reviewId });
      setDialog(undefined);
    } catch {
      setWriteError("GitHub rejected the pending review. Your local draft was preserved.");
    }
  };
  const submit = async (): Promise<void> => {
    try {
      const submitted = await props.onSubmitPending(event, summaryBody.trim());
      setPhase({ _tag: "submitted", reviewId: submitted.reviewId, event });
      setDialog(undefined);
    } catch {
      setWriteError("GitHub could not submit the pending review. Your local draft was preserved.");
    }
  };

  if (phase._tag === "submitted") return <p role="status" className="text-sm text-cyan-200">Review {phase.reviewId} submitted as {phase.event}.</p>;
  return (
    <section className="rounded-xl border border-slate-800 bg-slate-900 p-5" aria-label="GitHub review submission">
      <h2 className="text-lg font-semibold">GitHub review</h2>
      {writeError === undefined ? null : <p role="alert" className="mt-2 text-sm text-rose-200">{writeError}</p>}
      {phase._tag === "local" ? <button className="mt-3 rounded bg-cyan-700 px-3 py-2 text-sm" onClick={() => setDialog("create")} disabled={postable.length === 0}>Create pending review</button> : <><p className="mt-2 text-sm text-cyan-200">Pending review {phase.reviewId} created.</p><button className="mt-3 rounded bg-cyan-700 px-3 py-2 text-sm" onClick={() => setDialog("submit")}>Submit pending review</button></>}
      {dialog === "create" ? <div className="mt-4 rounded border border-slate-700 bg-slate-950 p-4" role="dialog" aria-label="Create pending review"><h3 className="font-medium">Create pending review</h3>{includesP0P1 ? <p className="mt-2 text-sm text-amber-200">P0/P1 findings are included in this review.</p> : null}<ul className="mt-3 space-y-2">{postable.map((comment) => <li key={comment.findingId} className="rounded border border-slate-800 p-2 text-sm"><strong>{comment.path}:{comment.line}</strong><p className="text-slate-300">{comment.body}</p></li>)}</ul><label className="mt-3 flex gap-2 text-sm"><input type="checkbox" checked={createAcknowledged} onChange={(event) => setCreateAcknowledged(event.target.checked)} />I understand this creates one pending GitHub review.</label><div className="mt-3 flex gap-2"><button className="rounded bg-cyan-700 px-3 py-2 text-sm" onClick={() => void create()} disabled={!createAcknowledged}>Confirm pending review</button><button className="rounded bg-slate-700 px-3 py-2 text-sm" onClick={() => setDialog(undefined)}>Cancel</button></div></div> : null}
      {dialog === "submit" ? <div className="mt-4 rounded border border-slate-700 bg-slate-950 p-4" role="dialog" aria-label="Submit pending review"><h3 className="font-medium">Submit pending review</h3>{includesP0P1 ? <p className="mt-2 text-sm text-amber-200">P0/P1 findings are included in this review.</p> : null}<label className="mt-3 block text-sm">Review event<select className="mt-1 block rounded border border-slate-700 bg-slate-900 p-2" value={event} onChange={(value) => setEvent(value.target.value as GitHubReviewEvent)}><option value="COMMENT">COMMENT</option><option value="APPROVE">APPROVE</option><option value="REQUEST_CHANGES">REQUEST_CHANGES</option></select></label><label className="mt-3 block text-sm">Review summary<textarea className="mt-1 block w-full rounded border border-slate-700 bg-slate-900 p-2" value={summaryBody} onChange={(value) => setSummaryBody(value.target.value)} /></label><label className="mt-3 flex gap-2 text-sm"><input type="checkbox" checked={submitAcknowledged} onChange={(value) => setSubmitAcknowledged(value.target.checked)} />I understand this submits the pending review.</label><div className="mt-3 flex gap-2"><button className="rounded bg-cyan-700 px-3 py-2 text-sm" onClick={() => void submit()} disabled={!submitAcknowledged || summaryBody.trim().length === 0}>Submit review</button><button className="rounded bg-slate-700 px-3 py-2 text-sm" onClick={() => setDialog(undefined)}>Cancel</button></div></div> : null}
    </section>
  );
}

function initialPhase(draft: Pick<ReviewDraft, "state">): DialogPhase {
  if (draft.state._tag === "PendingGitHubReview") return { _tag: "pending", reviewId: draft.state.pendingReviewId };
  if (draft.state._tag === "SubmittedGitHubReview") return { _tag: "submitted", reviewId: draft.state.reviewId, event: draft.state.event };
  return { _tag: "local" };
}
