import { useRef, useState } from "react";
import * as v from "valibot";

import { definedProps } from "../../../domain/defined-props";
import type { LocalPatchView } from "../../../domain/local-patch-view";
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

type SaveQueue = {
  readonly sessionId: string;
  readonly view: LocalPatchView | undefined;
  stored: ReadonlySet<string>;
  /** The set being saved; undefined while no save is in flight. */
  sending: ReadonlySet<string> | undefined;
  queued: ReadonlySet<string> | undefined;
};

type ViewedFilesState = {
  readonly sessionId: string;
  readonly view: LocalPatchView | undefined;
  readonly paths: ReadonlySet<string>;
  readonly saveFailed: boolean;
};

/**
 * Owns the Viewed marks of the shown patch, one session's patch view: a change applies at once,
 * saves send the whole set one at a time so a burst ends with the last set
 * stored, and a failed save restores the last stored set.
 */
export function useViewedFiles({
  profileId,
  reviewId,
  sessionId,
  view,
  savedPaths,
  onWorkbenchPatch,
}: {
  readonly profileId: string;
  readonly reviewId: string;
  readonly sessionId: string;
  /** The shown patch view of a shared local Review; absent on a Review without views, whose one patch is Combined. */
  readonly view: LocalPatchView | undefined;
  readonly savedPaths: ReadonlyArray<string> | undefined;
  /** Receives the stored set so a reopened Review starts from it. */
  readonly onWorkbenchPatch: (patch: ReviewWorkbenchPatch) => void;
}): ViewedFilesControls {
  const [state, setState] = useState<ViewedFilesState>(() => ({
    sessionId,
    view,
    paths: new Set(savedPaths),
    saveFailed: false,
  }));
  const latest = useLatestCommitted({ sessionId, view, onWorkbenchPatch });
  const save = useRef<SaveQueue>({
    sessionId,
    view,
    stored: new Set(savedPaths),
    sending: undefined,
    queued: undefined,
  });
  // A new head is a new session, and each view keeps its own marks; either starts from its stored marks.
  if (state.sessionId !== sessionId || state.view !== view) {
    // A return to a view starts from its latest save here, queued, in flight, or answered: the view's reread can predate it.
    const pending = save.current;
    setState({
      sessionId,
      view,
      paths:
        pending.sessionId === sessionId && pending.view === view
          ? (pending.queued ?? pending.sending ?? pending.stored)
          : new Set(savedPaths),
      saveFailed: false,
    });
  }

  // Each session and view owns its queue, so a switched-away Review's late answer cannot send the next one's marks.
  const send = (current: SaveQueue): void => {
    if (save.current !== current) return;
    const paths = current.queued;
    if (paths === undefined) return;
    current.queued = undefined;
    current.sending = paths;
    void requestJson("/v1/reviews/viewed-files", {
      method: "POST",
      body: {
        profileId,
        reviewId,
        sessionId,
        paths: [...paths],
        ...definedProps({ view }),
      },
    })
      .then((value) => {
        const parsed = v.safeParse(savedViewedFilesSchema, value);
        if (!parsed.success) throw new Error("invalid viewed files response");
        current.stored = new Set(parsed.output.paths);
        // The projection's `viewedPaths` are Combined's; another view's marks come with its patch.
        if (
          latest.current.sessionId === sessionId &&
          latest.current.view === view &&
          (view === undefined || view === "combined")
        )
          latest.current.onWorkbenchPatch({ viewedPaths: parsed.output.paths });
      })
      .catch(() => {
        // A later change is already queued and its save decides the stored set.
        if (current.queued !== undefined) return;
        setState((state) =>
          state.sessionId === sessionId && state.view === view
            ? { ...state, paths: current.stored, saveFailed: true }
            : state,
        );
      })
      .finally(() => {
        current.sending = undefined;
        send(current);
      });
  };

  const setPaths = (paths: ReadonlySet<string>): void => {
    if (save.current.sessionId !== sessionId || save.current.view !== view)
      save.current = {
        sessionId,
        view,
        stored: new Set(savedPaths),
        sending: undefined,
        queued: undefined,
      };
    setState({ sessionId, view, paths, saveFailed: false });
    save.current.queued = paths;
    if (save.current.sending === undefined) send(save.current);
  };

  return { paths: state.paths, saveFailed: state.saveFailed, setPaths };
}
