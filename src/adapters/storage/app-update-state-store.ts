import * as v from "valibot";

import { readJsonFile, writeAtomicJson } from "./json-file";
import type { PatchdeskPaths } from "./patchdesk-paths";

const appUpdateRecordSchema = v.object({
  lastLaunchedVersion: v.optional(v.string()),
  dismissedVersion: v.optional(v.string()),
  updateAttemptedFrom: v.optional(v.string()),
});

/** What the in-app update remembers between launches (#800). */
export type AppUpdateRecord = v.InferOutput<typeof appUpdateRecordSchema>;

/**
 * The update record in `app-update.json`. It is a convenience, not durable
 * review state: a missing or unreadable file reads as empty, which at worst
 * shows a dismissed release again.
 */
export class AppUpdateStateStore {
  constructor(private readonly paths: PatchdeskPaths) {}

  async load(): Promise<AppUpdateRecord> {
    const stored = await readJsonFile(this.paths.appUpdateStateFile());
    if (stored._tag === "err") return {};
    const parsed = v.safeParse(appUpdateRecordSchema, stored.value);
    return parsed.success ? parsed.output : {};
  }

  async save(record: AppUpdateRecord): Promise<boolean> {
    const saved = await writeAtomicJson(
      this.paths.appUpdateStateFile(),
      record,
    );
    return saved._tag === "ok";
  }
}
