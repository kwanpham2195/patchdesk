import { useState } from "react";

import type { CheckSummary, GitHubComments } from "../../../domain/github-context";
import type { GitHubReviewEvent, ReviewDraft } from "../../../domain/review-draft";
import type { ReviewResult } from "../../../domain/review-result";
import { ReviewSubmissionDialog } from "./review-submission-dialog";

type LocalDraftView = {
  readonly summaryBody: string;
  readonly comments: ReadonlyArray<{
    readonly findingId: string;
    readonly body: string;
    readonly postability: "postable";
  }>;
};

export type ReviewHistoryItem = {
  readonly id: string;
  readonly state: "ReviewCompleted" | "ReviewFailed" | "Stale" | "Discarded" | "Merged" | "IgnoredLateResult";
};

export function ReviewWorkbench(props: {
  readonly result: ReviewResult;
  readonly draft: LocalDraftView;
  readonly comments: GitHubComments;
  readonly checks: CheckSummary;
  readonly history: ReadonlyArray<ReviewHistoryItem>;
  readonly debugHref: string;
  readonly staleHead?: boolean;
  readonly canDiscard?: boolean;
  /** Product callers receive these callbacks from the authenticated main-process local API, never from gh in the renderer. */
  readonly submission?: {
    readonly draft: ReviewDraft;
    readonly onCreatePending: () => Promise<{ readonly reviewId: string }>;
    readonly onSubmitPending: (event: GitHubReviewEvent, summaryBody: string) => Promise<{ readonly reviewId: string }>;
  };
}): React.JSX.Element {
  const [draftBodies, setDraftBodies] = useState(() =>
    Object.fromEntries(props.draft.comments.map((comment) => [comment.findingId, comment.body])),
  );
  const [copied, setCopied] = useState(false);
  const [discarded, setDiscarded] = useState(false);
  const [reopenedAttempt, setReopenedAttempt] = useState<string | undefined>();
  const mappedFindingIds = new Set(props.draft.comments.map((comment) => comment.findingId));

  const copyValidationPlan = (): void => {
    const text = props.result.validationPlan.join("\n");
    void navigator.clipboard?.writeText(text);
    setCopied(true);
  };

  return (
    <main className="min-h-screen bg-slate-950 px-6 py-8 text-slate-100">
      <section className="mx-auto max-w-5xl space-y-6" aria-label="Completed review workbench">
        <header className="rounded-xl border border-slate-800 bg-slate-900 p-5">
          <p className="text-xs uppercase tracking-[.2em] text-cyan-300">Completed review</p>
          <h1 className="mt-2 text-2xl font-semibold">{props.result.changeSummary}</h1>
          <p className="mt-3 text-slate-300">Verdict: <strong>{props.result.verdict}</strong> · {props.result.summary}</p>
          <a className="mt-3 inline-block text-sm text-cyan-300 underline" href={props.debugHref}>Open safe debug details</a>
        </header>

        {props.staleHead ? <p role="status" className="rounded border border-amber-500/50 bg-amber-950/30 p-3 text-amber-200">GitHub posting is blocked because this review head is stale.</p> : null}
        {props.canDiscard ? <section className="rounded-xl border border-slate-800 bg-slate-900 p-5"><button className="rounded bg-slate-700 px-3 py-2 text-sm" onClick={() => setDiscarded(true)} disabled={discarded}>{discarded ? "Review discarded locally" : "Discard running review"}</button><p className="mt-2 text-sm text-slate-400">Discarding stops Patchdesk progress; it does not claim to abort the remote run.</p></section> : null}

        <section className="rounded-xl border border-slate-800 bg-slate-900 p-5" aria-label="Findings">
          <h2 className="text-lg font-semibold">Findings</h2>
          <ul className="mt-3 space-y-3">
            {props.result.findings.map((finding) => (
              <li key={finding.id} className="rounded border border-slate-800 p-3">
                <p><strong>{finding.severity}</strong> · {finding.title}</p>
                <p className="mt-1 text-sm text-slate-300">{finding.explanation}</p>
                {finding.mappingStatus !== "mapped" || !mappedFindingIds.has(finding.id) ? <p className="mt-2 text-sm text-amber-200">Unmapped — not postable</p> : <label className="mt-2 block text-sm" htmlFor={`draft-${finding.id}`}>Draft for {finding.id}<textarea id={`draft-${finding.id}`} className="mt-1 block w-full rounded border border-slate-700 bg-slate-950 p-2" value={draftBodies[finding.id] ?? ""} onChange={(event) => setDraftBodies((current) => ({ ...current, [finding.id]: event.target.value }))} /></label>}
              </li>
            ))}
          </ul>
          <p className="mt-3 text-sm text-slate-400">Draft edits stay local until you explicitly create a pending GitHub review.</p>
          {props.submission === undefined ? <p className="mt-3 text-sm text-slate-400">GitHub submission is unavailable until this completed review has a main-process review-write session.</p> : <ReviewSubmissionDialog draft={props.submission.draft} findings={props.result.findings} onCreatePending={props.submission.onCreatePending} onSubmitPending={props.submission.onSubmitPending} />}
        </section>

        <section className="rounded-xl border border-slate-800 bg-slate-900 p-5" aria-label="Existing GitHub review threads">
          <h2 className="text-lg font-semibold">Existing review threads</h2>
          {props.comments.threads.length === 0 ? <p className="mt-2 text-sm text-slate-400">No existing review threads.</p> : <ul className="mt-3 space-y-3">{props.comments.threads.map((thread) => <li key={thread.id} className="rounded border border-slate-800 p-3"><p className="text-sm text-slate-400">{thread.state}{thread.location === undefined ? "" : ` · ${thread.location.path}:${thread.location.line ?? ""}`}</p>{thread.comments.map((comment) => <div key={comment.id} className="mt-2"><strong>{comment.author}</strong><p className="text-sm text-slate-300">{comment.body}</p>{comment.url === undefined ? null : <a className="text-sm text-cyan-300 underline" href={comment.url}>Open on GitHub</a>}</div>)}</li>)}</ul>}
        </section>

        <section className="rounded-xl border border-slate-800 bg-slate-900 p-5" aria-label="Checks">
          <h2 className="text-lg font-semibold">Checks: {props.checks.overall}</h2>
          <ul className="mt-3 space-y-2">{props.checks.checks.map((check) => <li key={check.name} className="rounded border border-slate-800 p-3"><details><summary>{check.name} · {check.required === true ? "Required" : check.required === false ? "Optional" : "Requirement unknown"} · {check.conclusion ?? check.status}</summary><p className="mt-2 text-sm text-slate-300">{check.status}{check.url === undefined ? "" : " · "}<>{check.url === undefined ? null : <a className="text-cyan-300 underline" href={check.url}>Open check on GitHub</a>}</></p></details></li>)}</ul>
        </section>

        <section className="rounded-xl border border-slate-800 bg-slate-900 p-5" aria-label="Validation plan">
          <h2 className="text-lg font-semibold">Validation plan</h2>
          <ol className="mt-3 list-decimal space-y-1 pl-5 text-sm text-slate-300">{props.result.validationPlan.map((step) => <li key={step}>{step}</li>)}</ol>
          <button className="mt-3 rounded bg-slate-700 px-3 py-2 text-sm" onClick={copyValidationPlan}>Copy validation plan</button>
          {copied ? <p role="status" className="mt-2 text-sm text-cyan-200">Validation plan copied locally.</p> : null}
          <h3 className="mt-4 font-medium">Assumptions</h3>
          <ul className="mt-2 list-disc pl-5 text-sm text-slate-300">{props.result.assumptions.map((assumption) => <li key={assumption}>{assumption}</li>)}</ul>
        </section>

        <section className="rounded-xl border border-slate-800 bg-slate-900 p-5" aria-label="Review history">
          <h2 className="text-lg font-semibold">Review history</h2>
          <ul className="mt-3 flex flex-wrap gap-2">{props.history.map((item) => <li key={item.id}><button className="rounded border border-slate-700 px-3 py-2 text-sm" onClick={() => setReopenedAttempt(item.id)}>Attempt {item.id}: {item.state}</button></li>)}</ul>
          {reopenedAttempt === undefined ? null : <p role="status" className="mt-3 text-sm text-cyan-200">Reopened attempt {reopenedAttempt} in the workbench.</p>}
        </section>
      </section>
    </main>
  );
}
