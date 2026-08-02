import { useEffect, useState } from "react";

import type { PublicationPreviewResponse } from "../renderer-contracts";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "./ui/dialog";

export function PublicationPreviewDialog({
  preview,
  onPreview,
  onConfirm,
  disabled,
  autoOpen = false,
  onAutoOpenConsumed,
}: {
  readonly preview?: PublicationPreviewResponse;
  readonly onPreview: () => Promise<PublicationPreviewResponse>;
  readonly onConfirm: () => Promise<void>;
  readonly disabled?: boolean;
  readonly autoOpen?: boolean;
  readonly onAutoOpenConsumed?: () => void;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [loadedPreview, setLoadedPreview] = useState<PublicationPreviewResponse>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const openPreview = async (): Promise<void> => {
    setLoading(true);
    setError(false);
    try { setLoadedPreview(await onPreview()); setOpen(true); } catch { setError(true); } finally { setLoading(false); }
  };
  useEffect(() => {
    if (!autoOpen || disabled === true) return;
    onAutoOpenConsumed?.();
    void openPreview();
  // The caller toggles autoOpen after this one-shot request.
  }, [autoOpen, disabled]);
  const confirm = async (): Promise<void> => {
    setLoading(true);
    setError(false);
    try { await onConfirm(); setOpen(false); } catch { setError(true); } finally { setLoading(false); }
  };
  return <>
    <Button disabled={disabled === true || loading} onClick={() => void openPreview()}>{loading ? "Preparing…" : "Preview publication"}</Button>
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-h-[min(720px,calc(100vh-2rem))] max-w-2xl overflow-y-auto">
        <DialogHeader><DialogTitle>Review publication preview</DialogTitle></DialogHeader>
        {(loadedPreview ?? preview) === undefined ? <p className="text-sm text-muted-foreground">The preview is unavailable.</p> : <div className="space-y-4 text-sm"><div className="flex flex-wrap gap-2 text-xs text-muted-foreground"><span>Decision · {(loadedPreview ?? preview)?.event}</span><span>Head · {(loadedPreview ?? preview)?.headSha.slice(0, 12)}</span><span>{(loadedPreview ?? preview)?.inlineComments.length} inline comments</span></div><div><p className="mb-1 font-medium">Review body</p><pre className="max-h-56 overflow-auto whitespace-pre-wrap rounded-md border bg-muted/30 p-3 text-xs">{(loadedPreview ?? preview)?.body || "(empty body)"}</pre></div>{(loadedPreview ?? preview)?.inlineComments.length === 0 ? <p className="text-muted-foreground">No inline comments will be published.</p> : <div><p className="mb-1 font-medium">Inline comments</p><ul className="space-y-2">{(loadedPreview ?? preview)?.inlineComments.map((comment) => <li key={comment.itemId} className="rounded-md border p-2"><p className="text-xs text-muted-foreground">{comment.path}:{comment.line}</p><p className="mt-1 whitespace-pre-wrap">{comment.body}</p></li>)}</ul></div>}{(loadedPreview ?? preview)?.threadActions.length === 0 ? null : <p className="text-muted-foreground">{(loadedPreview ?? preview)?.threadActions.length} thread action{(loadedPreview ?? preview)?.threadActions.length === 1 ? "" : "s"} included.</p>}{(loadedPreview ?? preview)?.warnings.length === 0 ? null : <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs">{(loadedPreview ?? preview)?.warnings.map((warning) => <p key={warning}>{warning === "no_inline_comments" ? "This publication contains no inline comments." : "The GitHub decision changed since this preview."}</p>)}</div>}{error ? <p role="alert" className="text-destructive">Publication could not be completed. Refresh and review the current draft.</p> : null}</div>}
        <DialogFooter><Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button><Button disabled={loading || (loadedPreview ?? preview) === undefined} onClick={() => void confirm()}>Confirm publication</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  </>;
}
