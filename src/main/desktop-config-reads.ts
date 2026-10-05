import type { PatchdeskPaths } from "#src/adapters/storage/patchdesk-paths";
import { ProfileStore } from "#src/adapters/storage/profile-store";
import {
  notificationSettingsOf,
  type Appearance,
  type NotificationSettings,
} from "#src/domain/contracts";
import { normalizeExternalHosts } from "#src/domain/external-hosts";
import { err, ok, type Result } from "#src/domain/result";

/** The stored appearance, or "system" when no config file names one yet. */
export async function loadStoredAppearance(
  paths: PatchdeskPaths,
): Promise<Appearance> {
  const config = await new ProfileStore(paths).loadConfig();
  return config._tag === "ok"
    ? (config.value.appearance ?? "system")
    : "system";
}

/** The stored notification toggles; a missing config file is a first run with the defaults. */
export async function loadNotificationSettings(
  paths: PatchdeskPaths,
): Promise<Result<NotificationSettings, "config_unreadable">> {
  const config = await new ProfileStore(paths).loadConfig();
  if (config._tag === "ok") return ok(notificationSettingsOf(config.value));
  return config.error.reason === "not_found"
    ? ok(notificationSettingsOf({}))
    : err("config_unreadable");
}

export async function loadAllowedExternalHosts(
  paths: PatchdeskPaths,
): Promise<ReadonlySet<string>> {
  const profiles = await new ProfileStore(paths).list();
  return normalizeExternalHosts([
    "github.com",
    ...(profiles._tag === "ok"
      ? profiles.value.map((profile) => profile.githubHost)
      : []),
  ]);
}
