import { readFile, realpath } from "node:fs/promises";

import type { AgentExplanation } from "../domain/agent-explanation";
import type { ReviewAnchorFingerprint } from "../domain/diff-anchor";
import type { RepoRelativePath } from "../domain/ids";
import type { LocalDraft } from "../domain/local-draft";
import {
  carryAgentExplanation,
  carryLocalDraft,
  type LocalDraftCarryTarget,
} from "../domain/local-draft-carry";
import type {
  LocalPatchView,
  StoredLocalPatchView,
} from "../domain/local-patch-view";
import type { LocalReviewSession } from "../domain/review-session";
import { readCheckoutFile } from "./local-apply-checkout";
import type { LocalReviewSessionPreparation } from "./local-review-session-preparation";

/**
 * Read the new view of every draft and Agent explanation before Apply
 * settlement can change the stored Finding drafts (#568). An explanation has
 * no view field, so it reads Combined.
 */
export async function readCarryTargets(
  drafts: ReadonlyArray<{
    readonly view?: StoredLocalPatchView;
    readonly anchor: Pick<ReviewAnchorFingerprint, "path">;
  }>,
  session: LocalReviewSession,
  preparation: Pick<LocalReviewSessionPreparation, "readCommitFiles">,
): Promise<ReadonlyMap<LocalPatchView, LocalDraftCarryTarget> | undefined> {
  const originView = (draft: (typeof drafts)[number]): LocalPatchView =>
    draft.view ?? "combined";
  const pathsByView = new Map<LocalPatchView, Set<RepoRelativePath>>();
  for (const draft of drafts) {
    const paths = pathsByView.get(originView(draft)) ?? new Set();
    pathsByView.set(originView(draft), paths.add(draft.anchor.path));
  }
  const targets = new Map<LocalPatchView, LocalDraftCarryTarget>();
  for (const [view, paths] of pathsByView) {
    const target = await carryTargetOf(session, view, [...paths], preparation);
    if (target === undefined) return undefined;
    targets.set(view, target);
  }
  return targets;
}

/** Carry drafts after settlement using the target files read before it, preserving applied Findings. */
export function carryToSession(
  drafts: ReadonlyArray<LocalDraft>,
  targets: ReadonlyMap<LocalPatchView, LocalDraftCarryTarget>,
): ReadonlyArray<LocalDraft> {
  return drafts.map((draft) => {
    const target = targets.get(draft.view ?? "combined");
    return target === undefined ? draft : carryLocalDraft(draft, target);
  });
}

/** Carry Agent explanations to the new Combined patch, dropping those it cannot place (#665). */
export function carryAgentExplanationsToSession(
  explanations: ReadonlyArray<AgentExplanation>,
  targets: ReadonlyMap<LocalPatchView, LocalDraftCarryTarget>,
): ReadonlyArray<AgentExplanation> {
  const combined = targets.get("combined");
  if (combined === undefined) return [];
  return explanations.flatMap(
    (explanation) => carryAgentExplanation(explanation, combined) ?? [],
  );
}

/**
 * One view's patch of `session` and the text of `paths` in that view's new
 * tree: the Local snapshot, read from the session's worktree, for Combined
 * and Uncommitted; the checkout `HEAD` commit, read as git objects, for
 * Committed.
 */
async function carryTargetOf(
  session: LocalReviewSession,
  view: LocalPatchView,
  paths: ReadonlyArray<RepoRelativePath>,
  preparation: Pick<LocalReviewSessionPreparation, "readCommitFiles">,
): Promise<LocalDraftCarryTarget | undefined> {
  const patchPath =
    view === "combined"
      ? session.patchPath
      : session.viewPatches?.[view].patchPath;
  if (patchPath === undefined) return undefined;
  const patch = await readFile(patchPath, "utf8").catch(() => undefined);
  if (patch === undefined) return undefined;
  if (view === "committed") {
    if (session.checkoutHeadSha === undefined) return undefined;
    const files = await preparation.readCommitFiles(
      session,
      session.checkoutHeadSha,
      paths,
    );
    return files._tag === "ok"
      ? { sessionId: session.id, patch, files: files.value }
      : undefined;
  }
  // `readCheckoutFile` refuses any path whose resolution differs, so the root is resolved first.
  const root = await realpath(session.worktree.path).catch(() => undefined);
  if (root === undefined) return undefined;
  const files = new Map<RepoRelativePath, string>();
  await Promise.all(
    paths.map(async (path) => {
      const bytes = await readCheckoutFile(root, path);
      if (bytes !== undefined) files.set(path, bytes.toString("utf8"));
    }),
  );
  return { sessionId: session.id, patch, files };
}
