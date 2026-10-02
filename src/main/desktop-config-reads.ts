import { PatchdeskPaths } from "../adapters/storage/patchdesk-paths";
import { ProfileStore } from "../adapters/storage/profile-store";
import {
  notificationSettingsOf,
  type Appearance,
  type NotificationSettings,
} from "../domain/contracts";
import { normalizeExternalHosts } from "../domain/external-hosts";
import { err, ok, type Result } from "../domain/result";

/** The stored appearance, or "system" when no config file names one yet. */
export async function loadStoredAppearance(): Promise<Appearance> {
  const config = await new ProfileStore(PatchdeskPaths.default()).loadConfig();
  return config._tag === "ok"
    ? (config.value.appearance ?? "system")
    : "system";
}

/** The stored notification toggles; a missing config file is a first run with the defaults. */
export async function loadNotificationSettings(): Promise<
  Result<NotificationSettings, "config_unreadable">
> {
  const config = await new ProfileStore(PatchdeskPaths.default()).loadConfig();
  if (config._tag === "ok") return ok(notificationSettingsOf(config.value));
  return config.error.reason === "not_found"
    ? ok(notificationSettingsOf({}))
    : err("config_unreadable");
}

export async function loadAllowedExternalHosts(): Promise<ReadonlySet<string>> {
  const profiles = await new ProfileStore(PatchdeskPaths.default()).list();
  return normalizeExternalHosts([
    "github.com",
    ...(profiles._tag === "ok"
      ? profiles.value.map((profile) => profile.githubHost)
      : []),
  ]);
}
