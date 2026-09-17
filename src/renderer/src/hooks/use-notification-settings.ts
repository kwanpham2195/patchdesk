import { useCallback, useEffect, useRef, useState } from "react";
import * as v from "valibot";

import {
  notificationSettingsOf,
  type NotificationSettings,
} from "../../../domain/contracts";
import { requestJson } from "../api-client";

// Loose: `/v1/settings` also carries appearance and diff theme, which this hook does not own.
const settingsResponseSchema = v.looseObject({
  notifications: v.optional(
    v.strictObject({ enabled: v.boolean(), preparationAndMerge: v.boolean() }),
  ),
});

/** The loaded toggles, or why they are not shown. */
type NotificationSettingsState =
  | { readonly _tag: "loading" }
  | { readonly _tag: "ready"; readonly settings: NotificationSettings }
  | { readonly _tag: "unavailable" };

async function readNotificationSettings(
  request: Promise<Awaited<ReturnType<typeof requestJson>>>,
): Promise<NotificationSettings> {
  const parsed = v.safeParse(settingsResponseSchema, await request);
  if (!parsed.success) throw new Error("invalid settings response");
  const { notifications } = parsed.output;
  return notificationSettingsOf(
    notifications === undefined ? {} : { notifications },
  );
}

/** What the Notifications card reads and calls. */
type NotificationSettingsControls = {
  readonly state: NotificationSettingsState;
  readonly saveFailed: boolean;
  readonly update: (next: NotificationSettings) => Promise<void>;
};

/**
 * Loads and saves the desktop notification toggles in Settings → General.
 * A save applies at once and is reverted when `PATCH /v1/settings` fails;
 * only the latest save may settle the state.
 */
export function useNotificationSettings(): NotificationSettingsControls {
  const [state, setState] = useState<NotificationSettingsState>({
    _tag: "loading",
  });
  const [saveFailed, setSaveFailed] = useState(false);
  const generation = useRef(0);

  useEffect(() => {
    const owner = generation.current;
    const load = async (): Promise<void> => {
      try {
        const settings = await readNotificationSettings(
          requestJson("/v1/settings"),
        );
        if (generation.current === owner) setState({ _tag: "ready", settings });
      } catch {
        if (generation.current === owner) setState({ _tag: "unavailable" });
      }
    };
    void load();
  }, []);

  const update = useCallback(
    async (next: NotificationSettings): Promise<void> => {
      if (state._tag !== "ready") return;
      const previous = state.settings;
      const owner = ++generation.current;
      setState({ _tag: "ready", settings: next });
      setSaveFailed(false);
      try {
        const saved = await readNotificationSettings(
          requestJson("/v1/settings", {
            method: "PATCH",
            body: { notifications: next },
          }),
        );
        if (generation.current === owner)
          setState({ _tag: "ready", settings: saved });
      } catch {
        if (generation.current !== owner) return;
        setState({ _tag: "ready", settings: previous });
        setSaveFailed(true);
      }
    },
    [state],
  );

  return { state, saveFailed, update };
}
