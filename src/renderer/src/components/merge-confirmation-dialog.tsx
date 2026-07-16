import { useState } from "react";

import type { MergeReadiness } from "../../../domain/merge-readiness";

export type MergeMethod = "merge" | "squash" | "rebase";

/** Renderer confirmation surface; it can call a privileged merge seam only after explicit user acknowledgement. */
export function MergeConfirmationDialog(props: {
  readonly readiness: MergeReadiness;
  readonly context: { readonly repo: string; readonly prNumber: number; readonly title: string; readonly base: string; readonly head: string; readonly headSha: string };
  readonly methods: ReadonlyArray<MergeMethod>;
  readonly onMerge: (method: MergeMethod, acknowledgedWarnings: boolean) => Promise<{ readonly mergeCommitSha?: string }>;
}): React.JSX.Element {
  const [method, setMethod] = useState<MergeMethod>(props.methods[0] ?? "squash");
  const [open, setOpen] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [merged, setMerged] = useState<string | undefined>();
  if (merged !== undefined) return <p role="status" className="text-cyan-200">Merged {merged}.</p>;
  if (props.readiness._tag === "Blocked") return <section aria-label="Merge readiness" className="rounded border border-rose-700 bg-rose-950/30 p-4"><h2 className="font-semibold">Merge blocked</h2><ul className="mt-2 list-disc pl-5 text-sm">{props.readiness.blockers.map((blocker) => <li key={blocker}>{blocker}</li>)}</ul></section>;
  return <section aria-label="Merge readiness" className="rounded border border-slate-700 bg-slate-900 p-4"><h2 className="font-semibold">Merge readiness</h2>{props.readiness.warnings.length === 0 ? <p className="mt-2 text-sm text-cyan-200">No merge warnings.</p> : <ul className="mt-2 list-disc pl-5 text-sm text-amber-200">{props.readiness.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>}<label className="mt-3 block text-sm">Merge method<select className="mt-1 block rounded bg-slate-950 p-2" value={method} onChange={(event) => setMethod(event.target.value as MergeMethod)}>{props.methods.map((candidate) => <option key={candidate} value={candidate}>{candidate}</option>)}</select></label><button className="mt-3 rounded bg-cyan-700 px-3 py-2 text-sm" onClick={() => setOpen(true)}>Prepare merge confirmation</button>{open ? <div role="dialog" aria-label="Confirm merge" className="mt-4 rounded border border-slate-700 bg-slate-950 p-4"><h3 className="font-semibold">Confirm merge</h3><p className="mt-2 text-sm">{props.context.repo}#{props.context.prNumber} · {props.context.title}</p><p className="text-sm text-slate-300">{props.context.base} ← {props.context.head} · {props.context.headSha} · {method}</p>{props.readiness._tag === "NeedsAcknowledgement" ? <label className="mt-3 flex gap-2 text-sm"><input type="checkbox" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} />I acknowledge the merge warnings.</label> : null}<button className="mt-3 rounded bg-cyan-700 px-3 py-2 text-sm" disabled={props.readiness._tag === "NeedsAcknowledgement" && !acknowledged} onClick={() => void props.onMerge(method, acknowledged).then((result) => setMerged(result.mergeCommitSha ?? "pull request"))}>Confirm merge</button></div> : null}</section>;
}
