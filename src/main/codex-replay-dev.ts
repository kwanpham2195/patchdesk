import { join } from "node:path";

import { enableCodexReplayRecording } from "#src/adapters/codex/codex-replay-recorder";
import { registerDevelopmentExecutable } from "#src/adapters/process/executable-discovery";

/**
 * Dev-only Codex replay hooks, never active in a packaged app (#862).
 * `PATCHDESK_REPLAY_PROVIDER=1` makes every Codex lookup resolve to the replay
 * executable; `PATCHDESK_REPLAY_RECORD=<dir>` saves real Codex traffic for it.
 */
export function configureCodexReplay(
  environment: NodeJS.ProcessEnv,
  packaged: boolean,
  appPath: string,
): ReadonlyArray<string> {
  if (packaged) return [];
  const active: string[] = [];
  if (environment.PATCHDESK_REPLAY_PROVIDER === "1") {
    registerDevelopmentExecutable(
      "codex",
      join(appPath, "scripts", "replay", "codex-replay.mjs"),
    );
    active.push("provider");
  }
  const recordDirectory = environment.PATCHDESK_REPLAY_RECORD;
  if (recordDirectory !== undefined && recordDirectory !== "") {
    enableCodexReplayRecording(recordDirectory);
    active.push("record");
  }
  return active;
}
