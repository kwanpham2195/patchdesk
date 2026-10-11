import {
  createContext,
  createElement,
  useContext,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

import type { useReviewObservation } from "#src/renderer/src/flows/use-review-observation";
import type {
  GuideReadingAdmission,
  GuideReadingFlushRequest,
} from "#src/main/guide-reading-flush-channel";

/** One renderer lifetime owns the reading queues that navigation and orderly close must await. */
export type GuideReadingFlush = {
  readonly register: (
    flush: (retry: boolean) => Promise<boolean>,
  ) => () => void;
  readonly flush: (retry?: boolean) => Promise<boolean>;
  readonly navigate: (
    commit: () => void,
    allowDraft?: boolean,
  ) => Promise<boolean>;
  /** Guard evidence is sampled at admission, rather than trusting one-way IPC timing. */
  readonly registerGuard: (
    read: () => {
      readonly state: GuideReadingAdmission["state"];
      readonly draftIdentity: string;
    },
  ) => () => void;
  readonly admission: (
    request: GuideReadingFlushRequest,
  ) => Promise<GuideReadingAdmission>;
};

/** The app supplies this owner above both workbench and route disposal. */
export const GuideReadingFlushContext = createContext<
  GuideReadingFlush | undefined
>(undefined);

/** Renderer-wide registration is separate from review drafts and remains alive across tabs. */
export function GuideReadingFlushProvider({
  children,
}: {
  readonly children: ReactNode;
}): React.JSX.Element {
  const [owner] = useState<GuideReadingFlush>(() => {
    const queues = new Set<(retry: boolean) => Promise<boolean>>();
    const guards = new Set<
      () => {
        readonly state: GuideReadingAdmission["state"];
        readonly draftIdentity: string;
      }
    >();
    const rendererId = crypto.randomUUID();
    let identity = "";
    let revision = 0;
    const inspect = (): GuideReadingAdmission => {
      const current = [...guards].map((read) => read());
      const next = JSON.stringify(current.map((guard) => guard.draftIdentity));
      if (next !== identity) {
        identity = next;
        revision += 1;
      }
      return {
        saved: false,
        rendererId,
        draftRevision: revision,
        state: current.some((guard) => guard.state === "write_pending")
          ? "write_pending"
          : current.some((guard) => guard.state === "dirty_draft")
            ? "dirty_draft"
            : "clear",
      };
    };
    const flush = async (retry = false): Promise<boolean> => {
      const results = await Promise.allSettled(
        [...queues].map((save) => Promise.resolve().then(() => save(retry))),
      );
      return results.every(
        (result) => result.status === "fulfilled" && result.value,
      );
    };
    return {
      register(flush) {
        queues.add(flush);
        return () => {
          queues.delete(flush);
        };
      },
      flush,
      async navigate(commit, allowDraft = false) {
        const before = inspect();
        if (
          before.state === "write_pending" ||
          (!allowDraft && before.state === "dirty_draft")
        )
          return false;
        if (!(await flush())) return false;
        const after = inspect();
        if (
          after.state === "write_pending" ||
          after.draftRevision !== before.draftRevision
        )
          return false;
        commit();
        return true;
      },
      registerGuard(read) {
        guards.add(read);
        return () => {
          guards.delete(read);
        };
      },
      async admission(request) {
        const before = inspect();
        if (
          request.phase === "inspect" ||
          before.state === "write_pending" ||
          before.draftRevision !== request.approvedDraftRevision ||
          before.rendererId !== request.approvedRendererId
        )
          return before;
        const saved = await flush(request.retryReading === true);
        const after = inspect();
        return {
          ...after,
          saved:
            saved &&
            after.state !== "write_pending" &&
            after.draftRevision === request.approvedDraftRevision &&
            after.rendererId === request.approvedRendererId,
        };
      },
    };
  });
  useEffect(
    () => window.patchdesk?.onGuideReadingFlush(owner.admission),
    [owner],
  );
  return createElement(
    GuideReadingFlushContext.Provider,
    { value: owner },
    children,
  );
}

/** A command starts holding close synchronously, before React can commit its busy state. */
export function useGuideReadingCommands(
  run: ReturnType<typeof useReviewObservation>["runDirectCommand"],
): ReturnType<typeof useReviewObservation>["runDirectCommand"] {
  const owner = useContext(GuideReadingFlushContext);
  const active = useRef(0);
  useLayoutEffect(
    () =>
      owner?.registerGuard(() => ({
        state: active.current > 0 ? "write_pending" : "clear",
        draftIdentity: "",
      })),
    [owner],
  );
  return useCallback(
    async <T>(operation: () => Promise<T>): Promise<T> => {
      active.current += 1;
      try {
        return await run(operation);
      } finally {
        active.current -= 1;
      }
    },
    [run],
  );
}

/** Hidden readers retain their queue, but screen transitions still wait for confirmation. */
export function useGuideReadingTransition<T>(
  commit: (input: T) => void,
  reading: boolean,
): (input: T) => void {
  const owner = useContext(GuideReadingFlushContext);
  return useCallback(
    (input: T): void => {
      if (!reading || owner === undefined) {
        commit(input);
        return;
      }
      void owner.flush().then((saved) => {
        if (saved) commit(input);
      });
    },
    [commit, owner, reading],
  );
}

/** Navigation uses the same completion condition as the desktop close handshake. */
export function useGuideReadingFlush(): GuideReadingFlush {
  const owner = useContext(GuideReadingFlushContext);
  if (owner === undefined)
    throw new Error("Guide reading flush requires the app lifetime owner");
  return owner;
}
