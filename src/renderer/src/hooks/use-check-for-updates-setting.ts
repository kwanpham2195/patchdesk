import { useCallback, useEffect, useRef, useState } from "react";
import * as v from "valibot";

import { requestJson } from "../api-client";

// Loose: `/v1/settings` also carries the settings other hooks own.
const settingsResponseSchema = v.looseObject({
  checkForUpdates: v.optional(v.boolean(), true),
});

/** The loaded switch, or why it is not shown. */
type CheckForUpdatesState =
  | { readonly _tag: "loading" }
  | { readonly _tag: "ready"; readonly enabled: boolean }
  | { readonly _tag: "unavailable" };

/** What the Updates card reads and calls. */
type CheckForUpdatesControls = {
  readonly state: CheckForUpdatesState;
  readonly saveFailed: boolean;
  readonly update: (enabled: boolean) => Promise<void>;
};

async function readCheckForUpdates(
  request: Promise<Awaited<ReturnType<typeof requestJson>>>,
): Promise<boolean> {
  const parsed = v.safeParse(settingsResponseSchema, await request);
  if (!parsed.success) throw new Error("invalid settings response");
  return parsed.output.checkForUpdates;
}

/**
 * Loads and saves Settings → General → Check for updates (#800); absent means
 * on. A save applies at once and is reverted when `PATCH /v1/settings` fails;
 * only the latest save may settle the state.
 */
export function useCheckForUpdatesSetting(): CheckForUpdatesControls {
  const [state, setState] = useState<CheckForUpdatesState>({
    _tag: "loading",
  });
  const [saveFailed, setSaveFailed] = useState(false);
  const generation = useRef(0);

  useEffect(() => {
    const owner = generation.current;
    const load = async (): Promise<void> => {
      try {
        const enabled = await readCheckForUpdates(requestJson("/v1/settings"));
        if (generation.current === owner) setState({ _tag: "ready", enabled });
      } catch {
        if (generation.current === owner) setState({ _tag: "unavailable" });
      }
    };
    void load();
  }, []);

  const update = useCallback(
    async (enabled: boolean): Promise<void> => {
      if (state._tag !== "ready") return;
      const previous = state.enabled;
      const owner = ++generation.current;
      setState({ _tag: "ready", enabled });
      setSaveFailed(false);
      try {
        const saved = await readCheckForUpdates(
          requestJson("/v1/settings", {
            method: "PATCH",
            body: { checkForUpdates: enabled },
          }),
        );
        if (generation.current === owner)
          setState({ _tag: "ready", enabled: saved });
      } catch {
        if (generation.current !== owner) return;
        setState({ _tag: "ready", enabled: previous });
        setSaveFailed(true);
      }
    },
    [state],
  );

  return { state, saveFailed, update };
}
