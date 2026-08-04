import { useEffect, useRef, useState } from "react";

import type { PublicationPreviewResponse } from "../renderer-contracts";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "./ui/dialog";

export function PublicationPreviewDialog({
  preview,
  onPreview,
  onConfirm,
  disabled,
  publicationState,
  onRecover,
  onOpenGitHub,
  onViewFeedback,
  recoveryEvidence,
  autoOpen = false,
  onAutoOpenConsumed,
}: {
  readonly preview?: PublicationPreviewResponse;
  readonly onPreview: () => Promise<PublicationPreviewResponse>;
  readonly onConfirm: () => Promise<void>;
  readonly disabled?: boolean;
  readonly publicationState?: "ready" | "publishing" | "confirmed" | "needs_confirmation";
  readonly onRecover?: () => Promise<void>;
  readonly onOpenGitHub?: () => Promise<void>;
  readonly onViewFeedback?: () => void;
  readonly recoveryEvidence?: { readonly confirmed: ReadonlyArray<string>; readonly notConfirmed: ReadonlyArray<string>; readonly unableToVerify: string };
  readonly autoOpen?: boolean;
  readonly onAutoOpenConsumed?: () => void;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [loadedPreview, setLoadedPreview] = useState<PublicationPreviewResponse>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [state, setState] = useState<"ready" | "publishing" | "confirmed" | "needs_confirmation">(publicationState ?? "ready");
  const feedbackNavigationPending = useRef(false);
  useEffect(() => {
    if (publicationState !== undefined) setState((current) => current === "confirmed" && publicationState === "ready" ? current : publicationState);
  }, [publicationState]);
  const closeable = state !== "publishing";
  const triggerDisabled = disabled === true && state !== "needs_confirmation";
  const openPreview = async (): Promise<void> => {
    setLoading(true);
    setError(false);
    try { setLoadedPreview(await onPreview()); setOpen(true); } catch { setError(true); setOpen(true); } finally { setLoading(false); }
  };
  useEffect(() => {
    if (!autoOpen || triggerDisabled) return;
    onAutoOpenConsumed?.();
    void openPreview();
  // The caller toggles autoOpen after this one-shot request.
  }, [autoOpen, triggerDisabled]);
  useEffect(() => {
    if (open || !feedbackNavigationPending.current) return;
    let timer: number | undefined;
    const afterClose = (): void => {
      if (document.querySelector("[data-publication-preview-dialog]") !== null) {
        timer = window.setTimeout(afterClose, 0);
        return;
      }
      feedbackNavigationPending.current = false;
      onViewFeedback?.();
    };
    afterClose();
    return () => { if (timer !== undefined) window.clearTimeout(timer); };
  }, [open, onViewFeedback]);
  const confirm = async (): Promise<void> => {
    if (state !== "ready") return;
    setLoading(true);
    setError(false);
    setState("publishing");
    try { await onConfirm(); setState("confirmed"); } catch { setError(true); setState("needs_confirmation"); } finally { setLoading(false); }
  };
  return <>
    <Button disabled={triggerDisabled || loading} onClick={() => void openPreview()}>{state === "needs_confirmation" ? "Review publication recovery" : loading ? "Preparing…" : "Preview publication"}</Button>
    <Dialog open={open} onOpenChange={(next) => { if (next || closeable) setOpen(next); }}>
      <DialogContent showCloseButton={closeable} data-publication-preview-dialog className="max-h-[min(720px,calc(100vh-2rem))] max-w-2xl overflow-y-auto" aria-busy={state === "publishing"}>
        <DialogHeader><DialogTitle>Review publication preview</DialogTitle><p role="status" className="text-sm text-muted-foreground">{state === "ready" ? "Ready to publish" : state === "publishing" ? "Publishing…" : state === "confirmed" ? "Publication confirmed" : "Needs confirmation"}</p></DialogHeader>
        {state === "needs_confirmation" ? <div className="space-y-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3" role="status"><p className="font-medium">Durable publication evidence</p><div><p className="font-medium">Confirmed</p>{(recoveryEvidence?.confirmed ?? []).length === 0 ? <p className="text-muted-foreground">No receipts confirmed before the uncertain operation.</p> : <ul className="list-disc pl-5">{recoveryEvidence?.confirmed.map((entry) => <li key={entry}>{entry}</li>)}</ul>}</div><div><p className="font-medium">Not confirmed</p>{(recoveryEvidence?.notConfirmed ?? []).length === 0 ? <p className="text-muted-foreground">No remaining operation is known to be unconfirmed.</p> : <ul className="list-disc pl-5">{recoveryEvidence?.notConfirmed.map((entry) => <li key={entry}>{entry}</li>)}</ul>}</div><div><p className="font-medium">Unable to verify</p><p className="text-muted-foreground">{recoveryEvidence?.unableToVerify ?? "GitHub must be checked before any further action."}</p></div></div> : null}
        {(loadedPreview ?? preview) === undefined ? <p className="text-sm text-muted-foreground">The preview is unavailable.</p> : <div className="space-y-4 text-sm"><div className="flex flex-wrap gap-2 text-xs text-muted-foreground"><span>Decision · {(loadedPreview ?? preview)?.event}</span><span>Head · {(loadedPreview ?? preview)?.headSha.slice(0, 12)}</span><span>{(loadedPreview ?? preview)?.inlineComments.length} inline comments</span></div><div><p className="mb-1 font-medium">Review body</p><pre className="max-h-56 overflow-auto whitespace-pre-wrap rounded-md border bg-muted/30 p-3 text-xs">{(loadedPreview ?? preview)?.body || "(empty body)"}</pre></div>{(loadedPreview ?? preview)?.inlineComments.length === 0 ? <p className="text-muted-foreground">No inline comments will be published.</p> : <div><p className="mb-1 font-medium">Inline comments</p><ul className="space-y-2">{(loadedPreview ?? preview)?.inlineComments.map((comment) => <li key={comment.itemId} className="rounded-md border p-2"><p className="text-xs text-muted-foreground">{comment.path}:{comment.line}</p><p className="mt-1 whitespace-pre-wrap">{comment.body}</p></li>)}</ul></div>}{(loadedPreview ?? preview)?.threadActions.length === 0 ? null : <p className="text-muted-foreground">{(loadedPreview ?? preview)?.threadActions.length} thread action{(loadedPreview ?? preview)?.threadActions.length === 1 ? "" : "s"} included.</p>}{(loadedPreview ?? preview)?.warnings.length === 0 ? null : <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs">{(loadedPreview ?? preview)?.warnings.map((warning) => <p key={warning}>{warning === "no_inline_comments" ? "This publication contains no inline comments." : "The GitHub decision changed since this preview."}</p>)}</div>}{error ? <p role="alert" className="text-destructive">Publication could not be completed. Refresh and review the current draft.</p> : null}</div>}
        <DialogFooter>{state === "publishing" ? null : <Button variant="outline" onClick={() => setOpen(false)}>{state === "needs_confirmation" ? "Close" : "Back to draft"}</Button>}{state === "needs_confirmation" ? <><Button variant="outline" onClick={() => void onOpenGitHub?.()}>Open on GitHub</Button><Button variant="outline" onClick={() => void onRecover?.()}>Check GitHub again</Button></> : null}{state === "confirmed" ? <><Button variant="outline" onClick={() => { feedbackNavigationPending.current = true; setOpen(false); }}>View feedback</Button><Button onClick={() => setOpen(false)}>Close</Button></> : state === "ready" ? <Button disabled={loading || (loadedPreview ?? preview) === undefined} onClick={() => void confirm()}>Confirm publication</Button> : null}</DialogFooter>
      </DialogContent>
    </Dialog>
  </>;
}
