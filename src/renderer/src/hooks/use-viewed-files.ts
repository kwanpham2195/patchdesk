import { useRef, useState } from "react";
import * as v from "valibot";

import { requestJson } from "../api-client";
import type { ReviewWorkbenchPatch } from "../flows/use-review-observation";
import { useLatestCommitted } from "./use-latest-committed";

/** The Viewed marks one Review session's Diff renders and edits. */
export type ViewedFilesControls = {
  readonly paths: ReadonlySet<string>;
  readonly saveFailed: boolean;
  readonly setPaths: (paths: ReadonlySet<string>) => void;
};

const savedViewedFilesSchema = v.strictObject({
  paths: v.array(v.pipe(v.string(), v.minLength(1))),
});

type ViewedFilesState = {
  readonly sessionId: string;
  readonly paths: ReadonlySet<string>;
  readonly saveFailed: boolean;
};

/**
 * Owns the Viewed marks of the represented session: a change applies at once,
 * saves send the whole set one at a time so a burst ends with the last set
 * stored, and a failed save restores the last stored set.
 */
export function useViewedFiles({
  profileId,
  reviewId,
  sessionId,
  savedPaths,
  onWorkbenchPatch,
}: {
  readonly profileId: string;
  readonly reviewId: string;
  readonly sessionId: string;
  readonly savedPaths: ReadonlyArray<string> | undefined;
  /** Receives the stored set so a reopened Review starts from it. */
  readonly onWorkbenchPatch: (patch: ReviewWorkbenchPatch) => void;
}): ViewedFilesControls {
  const [state, setState] = useState<ViewedFilesState>(() => ({
    sessionId,
    paths: new Set(savedPaths),
    saveFailed: false,
  }));
  // A new head is a new session, which starts from its own stored marks.
  if (state.sessionId !== sessionId)
    setState({ sessionId, paths: new Set(savedPaths), saveFailed: false });
  const latest = useLatestCommitted({ sessionId, onWorkbenchPatch });
  const save = useRef<{
    sessionId: string;
    stored: ReadonlySet<string>;
    inFlight: boolean;
    queued: ReadonlySet<string> | undefined;
  }>({
    sessionId,
    stored: new Set(savedPaths),
    inFlight: false,
    queued: undefined,
  });

  const send = (): void => {
    const current = save.current;
    const paths = current.queued;
    if (paths === undefined) return;
    current.queued = undefined;
    current.inFlight = true;
    void requestJson("/v1/reviews/viewed-files", {
      method: "POST",
      body: { profileId, reviewId, sessionId, paths: [...paths] },
    })
      .then((value) => {
        const parsed = v.safeParse(savedViewedFilesSchema, value);
        if (!parsed.success) throw new Error("invalid viewed files response");
        current.stored = new Set(parsed.output.paths);
        if (latest.current.sessionId === sessionId)
          latest.current.onWorkbenchPatch({ viewedPaths: parsed.output.paths });
      })
      .catch(() => {
        // A later change is already queued and its save decides the stored set.
        if (current.queued !== undefined) return;
        setState((state) =>
          state.sessionId === sessionId
            ? { ...state, paths: current.stored, saveFailed: true }
            : state,
        );
      })
      .finally(() => {
        current.inFlight = false;
        send();
      });
  };

  const setPaths = (paths: ReadonlySet<string>): void => {
    if (save.current.sessionId !== sessionId)
      save.current = {
        sessionId,
        stored: new Set(savedPaths),
        inFlight: false,
        queued: undefined,
      };
    setState({ sessionId, paths, saveFailed: false });
    save.current.queued = paths;
    if (!save.current.inFlight) send();
  };

  return { paths: state.paths, saveFailed: state.saveFailed, setPaths };
}
