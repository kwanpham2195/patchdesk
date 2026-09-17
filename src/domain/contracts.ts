import * as v from "valibot";

import { definedProps } from "./defined-props";
import { parseWorkspaceProfileId, type WorkspaceProfileId } from "./ids";
import { err, ok, type Result } from "./result";

export type InvalidDomainContract = {
  readonly _tag: "InvalidDomainContract";
  readonly boundary: "config" | "github" | "storage" | "runtime" | "ui";
};

export type PatchdeskConfigFile = {
  readonly lastSelectedProfileId?: WorkspaceProfileId;
  readonly appearance?: Appearance;
  readonly diffTheme?: DiffTheme;
  readonly notifications?: NotificationSettings;
};

/** How often watched pull requests are polled, in minutes (ADR 0045). */
export const WATCH_INTERVAL_MINUTES = [1, 3, 5, 10] as const;
type WatchIntervalMinutes = (typeof WATCH_INTERVAL_MINUTES)[number];

/**
 * The desktop notification settings (ADR 0044). `enabled` gates every
 * notification; `preparationAndMerge` additionally gates the two
 * lower-value ones; `intervalMinutes` paces the watched pull request poll
 * (ADR 0045). Stored and patched together.
 */
export type NotificationSettings = {
  readonly enabled: boolean;
  readonly preparationAndMerge: boolean;
  readonly intervalMinutes: WatchIntervalMinutes;
};

/** The settings a config that never saved them runs with. */
export function notificationSettingsOf(
  config: PatchdeskConfigFile,
): NotificationSettings {
  return (
    config.notifications ?? {
      enabled: true,
      preparationAndMerge: false,
      intervalMinutes: 3,
    }
  );
}

/** The stored appearance choice; "system" follows the OS preference. */
export type Appearance = "system" | "light" | "dark";

type DiffTheme = {
  readonly light: string;
  readonly dark: string;
};

export type PatchdeskSettingsPatch = {
  readonly appearance?: Appearance;
  readonly diffTheme?: DiffTheme;
  readonly notifications?: NotificationSettings;
};

// Strict like the rest of the file rather than ADR 0022's per-field fallback: config.json already fails closed as a whole.
const notificationSettingsSchema = v.strictObject({
  enabled: v.boolean(),
  preparationAndMerge: v.boolean(),
  intervalMinutes: v.picklist(WATCH_INTERVAL_MINUTES),
});

// A config saved before the poll interval existed stores the pair alone; it reads with the default interval.
const storedNotificationSettingsSchema = v.strictObject({
  enabled: v.boolean(),
  preparationAndMerge: v.boolean(),
  intervalMinutes: v.optional(v.picklist(WATCH_INTERVAL_MINUTES), 3),
});

/** Valibot schema for the global Patchdesk config file. */
const patchdeskConfigSchema = v.strictObject({
  lastSelectedProfileId: v.optional(v.string()),
  appearance: v.optional(v.picklist(["system", "light", "dark"])),
  diffTheme: v.optional(
    v.strictObject({
      light: v.pipe(v.string(), v.minLength(1)),
      dark: v.pipe(v.string(), v.minLength(1)),
    }),
  ),
  notifications: v.optional(storedNotificationSettingsSchema),
});

/** Valibot schema for the mutable, file-backed settings exposed by the desktop API. */
const patchdeskSettingsPatchSchema = v.strictObject({
  appearance: v.optional(v.picklist(["system", "light", "dark"])),
  diffTheme: v.optional(
    v.strictObject({
      light: v.pipe(v.string(), v.minLength(1)),
      dark: v.pipe(v.string(), v.minLength(1)),
    }),
  ),
  notifications: v.optional(notificationSettingsSchema),
});

/** Parse the global config boundary into profile IDs that core code can trust. */
export function parsePatchdeskConfig(
  input: unknown,
): Result<PatchdeskConfigFile, InvalidDomainContract> {
  const parsed = v.safeParse(patchdeskConfigSchema, input);
  return parsed.success
    ? parsePatchdeskConfigFields(parsed.output)
    : invalid("config");
}

/** Parses a complete settings patch and rejects empty or unknown command fields. */
export function parsePatchdeskSettingsPatch(
  input: unknown,
): Result<PatchdeskSettingsPatch, InvalidDomainContract> {
  const parsed = v.safeParse(patchdeskSettingsPatchSchema, input);
  if (
    !parsed.success ||
    (parsed.output.appearance === undefined &&
      parsed.output.diffTheme === undefined &&
      parsed.output.notifications === undefined)
  ) {
    return invalid("config");
  }

  return ok(
    definedProps({
      appearance: parsed.output.appearance,
      diffTheme: parsed.output.diffTheme,
      notifications: parsed.output.notifications,
    }),
  );
}

function parsePatchdeskConfigFields(input: {
  readonly lastSelectedProfileId?: string | undefined;
  readonly appearance?: Appearance | undefined;
  readonly diffTheme?: DiffTheme | undefined;
  readonly notifications?: NotificationSettings | undefined;
}): Result<PatchdeskConfigFile, InvalidDomainContract> {
  if (input.lastSelectedProfileId === undefined) {
    return ok(
      definedProps({
        appearance: input.appearance,
        diffTheme: input.diffTheme,
        notifications: input.notifications,
      }),
    );
  }

  const profileId = parseWorkspaceProfileId(input.lastSelectedProfileId);
  if (profileId._tag === "err") return invalid("config");
  return ok({
    lastSelectedProfileId: profileId.value,
    ...definedProps({
      appearance: input.appearance,
      diffTheme: input.diffTheme,
      notifications: input.notifications,
    }),
  });
}

function invalid(
  boundary: InvalidDomainContract["boundary"],
): Result<never, InvalidDomainContract> {
  return err({ _tag: "InvalidDomainContract", boundary });
}
