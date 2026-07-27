import { useEffect, useState } from "react";
import { GitMerge, ShieldAlert } from "lucide-react";

import type { MergeReadiness } from "../../../domain/merge-readiness";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export type MergeMethod = "merge" | "squash" | "rebase";

/** Fresh-read merge confirmation surface; privileged execution remains in main. */
export function MergeConfirmationDialog(props: {
  readonly readiness: MergeReadiness;
  readonly context: { readonly repo: string; readonly prNumber: number; readonly title: string; readonly base: string; readonly head: string; readonly headSha: string };
  readonly methods: ReadonlyArray<MergeMethod>;
  readonly onMerge: (method: MergeMethod, acknowledgedWarnings: boolean) => Promise<{ readonly mergeCommitSha?: string }>;
  readonly onPendingChange?: (pending: boolean) => void;
  /** When true, the confirmation body is rendered open at mount. Production callers leave this unset so the trigger-then-open flow is preserved. */
  readonly defaultOpen?: boolean;
}): React.JSX.Element {
  const [method, setMethod] = useState<MergeMethod>(props.methods[0] ?? "squash");
  const [open, setOpen] = useState(props.defaultOpen === true);
  const [acknowledged, setAcknowledged] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const [merged, setMerged] = useState<string>();
  useEffect(() => {
    props.onPendingChange?.(pending);
  }, [pending, props.onPendingChange]);

  const merge = async (): Promise<void> => {
    if (pending) return;
    setPending(true); setError(undefined);
    try { const result = await props.onMerge(method, acknowledged); setMerged(result.mergeCommitSha ?? "pull request"); setOpen(false); }
    catch { setError("GitHub did not confirm the merge. Refresh the pull request before retrying."); }
    finally { setPending(false); }
  };

  if (merged !== undefined) return <p role="status" className="text-sm text-primary">Merged {merged}.</p>;
  if (props.readiness._tag === "Blocked") return <Alert variant="destructive" aria-label="Merge readiness"><ShieldAlert /><AlertTitle>Merge blocked</AlertTitle><AlertDescription><ul className="mt-1 list-disc pl-5">{props.readiness.blockers.map((blocker) => <li key={blocker}>{blocker.replaceAll("_", " ")}</li>)}</ul></AlertDescription></Alert>;
  return (
    <section aria-label="Merge readiness" className="space-y-3">
      {error === undefined ? null : <Alert variant="destructive"><AlertTitle>Merge not confirmed</AlertTitle><AlertDescription>{error}</AlertDescription></Alert>}
      <div><Label htmlFor="merge-method">Merge method</Label><Select value={method} onValueChange={(value) => setMethod(value as MergeMethod)}><SelectTrigger id="merge-method" className="mt-1.5"><SelectValue /></SelectTrigger><SelectContent>{props.methods.map((candidate) => <SelectItem key={candidate} value={candidate}>{candidate}</SelectItem>)}</SelectContent></Select></div>
      <AlertDialog open={open} onOpenChange={(next) => { if (!pending) setOpen(next); }}>
        <AlertDialogTrigger render={<Button variant="outline" className="w-full" />}><GitMerge />Prepare merge confirmation</AlertDialogTrigger>
        <AlertDialogContent aria-busy={pending}>
          <AlertDialogHeader><AlertDialogTitle>Confirm merge</AlertDialogTitle><AlertDialogDescription>This is an irreversible GitHub write. Confirm the exact pull request, head SHA, and method.</AlertDialogDescription></AlertDialogHeader>
          <div className="space-y-3 text-sm"><div className="rounded-md border bg-muted p-3"><p className="font-medium">{props.context.repo}#{props.context.prNumber} · {props.context.title}</p><p className="mt-1 text-muted-foreground">{props.context.base} ← {props.context.head}</p><code className="mt-2 block break-all">{props.context.headSha}</code><Badge className="mt-2" variant="secondary">{method}</Badge></div>{props.readiness.warnings.length === 0 ? <p>No merge warnings.</p> : <Alert><ShieldAlert /><AlertTitle>Merge warnings</AlertTitle><AlertDescription>{props.readiness.warnings.map((warning) => warning.replaceAll("_", " ")).join(", ")}</AlertDescription></Alert>}{props.readiness._tag === "NeedsAcknowledgement" ? <div className="flex items-start gap-2"><Checkbox id="merge-ack" checked={acknowledged} onCheckedChange={(checked) => setAcknowledged(checked === true)} /><Label htmlFor="merge-ack" className="leading-5">I acknowledge the merge warnings.</Label></div> : null}</div>
          <AlertDialogFooter><AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel><AlertDialogAction disabled={pending || (props.readiness._tag === "NeedsAcknowledgement" && !acknowledged)} onClick={() => { void merge(); }}>{pending ? "Merging…" : "Confirm merge"}</AlertDialogAction></AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
