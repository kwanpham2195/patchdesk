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
  readonly profileId: string;
  readonly reviewId: string;
  readonly sessionId: string;
  readonly view: LocalPatchView | undefined;
  stored: ReadonlySet<string>;
  /** The set being saved; undefined while no save is in flight. */
  sending: ReadonlySet<string> | undefined;
  queued: ReadonlySet<string> | undefined;
  saveFailed: boolean;
};

type ViewedFilesState = {
  readonly profileId: string;
  readonly reviewId: string;
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
    profileId,
    reviewId,
    sessionId,
    view,
    paths: new Set(savedPaths),
    saveFailed: false,
  }));
  const latest = useLatestCommitted({
    profileId,
    reviewId,
    sessionId,
    view,
    onWorkbenchPatch,
  });
  const saves = useRef(new Map<string, SaveQueue>());
  const key = JSON.stringify([profileId, reviewId, sessionId, view]);
  // A return to a view can precede its last save's response or the workbench's reread.
  if (
    state.profileId !== profileId ||
    state.reviewId !== reviewId ||
    state.sessionId !== sessionId ||
    state.view !== view
  ) {
    const pending = saves.current.get(key);
    setState({
      profileId,
      reviewId,
      sessionId,
      view,
      paths: pending
        ? (pending.queued ?? pending.sending ?? pending.stored)
        : new Set(savedPaths),
      saveFailed: pending?.saveFailed ?? false,
    });
  }

  // Each session and view sends its own queue even when another view is shown.
  const send = (current: SaveQueue): void => {
    const paths = current.queued;
    if (paths === undefined) return;
    current.queued = undefined;
    current.sending = paths;
    void requestJson("/v1/reviews/viewed-files", {
      method: "POST",
      body: {
        profileId: current.profileId,
        reviewId: current.reviewId,
        sessionId: current.sessionId,
        paths: [...paths],
        ...definedProps({ view: current.view }),
      },
    })
      .then((value) => {
        const parsed = v.safeParse(savedViewedFilesSchema, value);
        if (!parsed.success) throw new Error("invalid viewed files response");
        current.stored = new Set(parsed.output.paths);
        current.saveFailed = false;
        // The projection's `viewedPaths` are Combined's; another view's marks come with its patch.
        if (
          latest.current.profileId === current.profileId &&
          latest.current.reviewId === current.reviewId &&
          latest.current.sessionId === current.sessionId &&
          latest.current.view === current.view &&
          (current.view === undefined || current.view === "combined")
        )
          latest.current.onWorkbenchPatch({ viewedPaths: parsed.output.paths });
      })
      .catch(() => {
        // A later change is already queued and its save decides the stored set.
        if (current.queued !== undefined) return;
        current.saveFailed = true;
        setState((state) =>
          state.profileId === current.profileId &&
          state.reviewId === current.reviewId &&
          state.sessionId === current.sessionId &&
          state.view === current.view
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
    let current = saves.current.get(key);
    if (current === undefined) {
      current = {
        profileId,
        reviewId,
        sessionId,
        view,
        stored: new Set(savedPaths),
        sending: undefined,
        queued: undefined,
        saveFailed: false,
      };
      saves.current.set(key, current);
    }
    setState({
      profileId,
      reviewId,
      sessionId,
      view,
      paths,
      saveFailed: false,
    });
    current.saveFailed = false;
    current.queued = paths;
    if (current.sending === undefined) send(current);
  };

  return { paths: state.paths, saveFailed: state.saveFailed, setPaths };
}
