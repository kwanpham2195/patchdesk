import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { requestJson } from "@/api-client";
import { parseModelCatalog, parseWalkthroughProjection, type ModelCatalog, type WalkthroughProjection } from "@/renderer-contracts";
import { loadReviewExecutionPreference, saveReviewExecutionPreference, type ReviewReasoningPreference } from "@/review-execution-preferences";

export type WalkthroughController = {
  readonly dialogOpen: boolean;
  readonly projection: WalkthroughProjection;
  readonly models: ReadonlyArray<{ readonly id: string; readonly label: string }>;
  readonly model: string | undefined;
  readonly reasoning: "low" | "medium" | "high";
  readonly catalogUnavailable: boolean;
  readonly onOpenDialog: () => void;
  readonly onCloseDialog: () => void;
  readonly onModelChange: (model: string) => void;
  readonly onReasoningChange: (reasoning: "low" | "medium" | "high") => void;
  readonly onConfirm: () => void;
  readonly onRetry: () => void;
  readonly onRegenerate: () => void;
  readonly busy: boolean;
};

/** Model-selection and request state for an optional reader of a prepared patch. */
export function useWalkthroughController({
  profileId,
  sessionId,
  headSha,
}: {
  readonly profileId: string;
  readonly sessionId: string;
  readonly headSha: string;
}): WalkthroughController {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [projection, setProjection] = useState<WalkthroughProjection>({ lifecycle: "idle", noticeKey: "walkthrough-idle" });
  const [busy, setBusy] = useState(false);
  const [models, setModels] = useState<ReadonlyArray<{ readonly id: string; readonly label: string }>>([]);
  const [model, setModel] = useState<string>();
  const [reasoning, setReasoning] = useState<ReviewReasoningPreference>("medium");
  const [catalogUnavailable, setCatalogUnavailable] = useState(false);
  const snapshotRef = useRef({ sessionId, headSha });
  useEffect(() => { snapshotRef.current = { sessionId, headSha }; }, [headSha, sessionId]);
  useEffect(() => {
    let active = true;
    void requestJson("/v1/reviews/models").then((value) => {
      if (!active) return;
      const catalog: ModelCatalog | undefined = parseModelCatalog(value);
      if (catalog === undefined) { setModels([]); setModel(undefined); setCatalogUnavailable(true); return; }
      const saved = loadReviewExecutionPreference(profileId);
      const restored = saved?.model !== undefined && catalog.models.some((candidate) => candidate.id === saved.model)
        ? saved.model
        : catalog.defaultModel !== undefined && catalog.models.some((candidate) => candidate.id === catalog.defaultModel)
          ? catalog.defaultModel
          : catalog.models[0]?.id;
      setModels(catalog.models); setModel(restored); setReasoning(saved?.reasoning ?? "medium"); setCatalogUnavailable(false);
    }).catch(() => { if (active) { setModels([]); setModel(undefined); setCatalogUnavailable(true); } });
    return () => { active = false; };
  }, [profileId]);
  const submit = useCallback(async () => {
    if (model === undefined) return;
    const snapshot = snapshotRef.current;
    saveReviewExecutionPreference(profileId, { model, reasoning });
    setBusy(true);
    try {
      const value = await requestJson("/v1/reviews/walkthrough/generate", { method: "POST", body: { profileId, sessionId: snapshot.sessionId, model, reasoning } });
      if (snapshotRef.current.sessionId !== snapshot.sessionId || snapshotRef.current.headSha !== snapshot.headSha) return;
      const next = parseWalkthroughProjection(value) ?? { lifecycle: "failed" as const, noticeKey: "walkthrough-failed" as const, actionKey: "walkthrough-retry" as const };
      setProjection(next);
      if (next.lifecycle === "ready" || next.lifecycle === "failed" || next.lifecycle === "stale") setDialogOpen(false);
    } catch {
      if (snapshotRef.current.sessionId === snapshot.sessionId && snapshotRef.current.headSha === snapshot.headSha) {
        setProjection({ lifecycle: "failed", noticeKey: "walkthrough-failed", actionKey: "walkthrough-retry" });
        setDialogOpen(false);
      }
    } finally {
      if (snapshotRef.current.sessionId === snapshot.sessionId && snapshotRef.current.headSha === snapshot.headSha) setBusy(false);
    }
  }, [model, profileId, reasoning]);
  return useMemo(() => ({
    dialogOpen,
    projection,
    models,
    model,
    reasoning,
    catalogUnavailable,
    onOpenDialog: () => setDialogOpen(true),
    onCloseDialog: () => setDialogOpen(false),
    onModelChange: setModel,
    onReasoningChange: setReasoning,
    onConfirm: () => { void submit(); },
    onRetry: () => { if (model === undefined) setDialogOpen(true); else void submit(); },
    onRegenerate: () => setDialogOpen(true),
    busy,
  }), [busy, catalogUnavailable, dialogOpen, model, models, projection, reasoning, submit]);
}
