import { join } from "node:path";
import type {
  UpgradeRefusal,
  UpgradeRefusalFile,
  UpgradeRefusalReason,
} from "#src/services/local-repository-upgrade-refusal";

/** Server details available after successful local API startup. */
export type StartedLocalApi = {
  readonly capability: string;
  readonly url: URL;
};

/** The safe result of starting the local API before the desktop workbench opens. */
export type LocalApiStartupResult<
  TServer extends StartedLocalApi = StartedLocalApi,
> =
  | { readonly _tag: "started"; readonly server: TServer }
  | { readonly _tag: "invalid-configuration" }
  /** A profile upgrade refused; the detail names the profile, reason and file. */
  | { readonly _tag: "upgrade-refused"; readonly detail: UpgradeRefusal }
  /** Startup stops when required current-state recovery cannot finish safely. */
  | { readonly _tag: "recovery-failed" };

/** Narrow server lifecycle dependency owned by the desktop composition root. */
type LocalApiLifecycle = {
  start(): Promise<LocalApiStartupResult>;
  healthCheck(server: StartedLocalApi): Promise<boolean>;
  stop(server: StartedLocalApi): Promise<void>;
};

/** Dependencies used to sequence local API startup before Electron shows the workbench. */
export type DesktopLifecycleDependencies = {
  readonly localApi: LocalApiLifecycle;
  showWorkbench(server: StartedLocalApi): Promise<void>;
};

/** Result from attempting to start the desktop workbench. */
type DesktopStartResult =
  | { readonly _tag: "started" }
  | { readonly _tag: "local-api-unavailable" }
  | { readonly _tag: "upgrade-refused"; readonly detail: UpgradeRefusal };

/** The desktop lifecycle handle `createDesktopLifecycle` hands its caller. */
export type DesktopLifecycle = {
  start(): Promise<DesktopStartResult>;
  stop(): Promise<void>;
};

/**
 * Starts the login-shell import and the desktop together, so the local API
 * and the window never wait for a shell to source the maintainer's dotfiles
 * (ADR 0038, amended 2026-09-19). The import is started first and kept, so
 * every reader that waits on it — a child spawn, the Pi child invoker, the
 * provider catalog, Codex discovery — waits for this launch's one import
 * rather than starting a second one. The caller owns both promises: it reads
 * `started` to decide whether the app can run at all, and awaits `imported`
 * afterwards.
 */
export function startDesktopBesideLoginShellImport(
  lifecycle: Pick<DesktopLifecycle, "start">,
  importLoginShellEnvironment: () => Promise<void>,
) {
  const imported = importLoginShellEnvironment();
  return { started: lifecycle.start(), imported };
}

/** Owns local API startup, health verification, workbench display, and shutdown ordering. */
export function createDesktopLifecycle(
  dependencies: DesktopLifecycleDependencies,
): DesktopLifecycle {
  let activeServer: StartedLocalApi | undefined;

  return {
    async start(): Promise<DesktopStartResult> {
      const startup = await dependencies.localApi.start();
      if (startup._tag === "upgrade-refused") return startup;
      if (startup._tag !== "started") {
        return { _tag: "local-api-unavailable" };
      }

      const server = startup.server;
      activeServer = server;

      let isHealthy: boolean;
      try {
        isHealthy = await dependencies.localApi.healthCheck(server);
      } catch {
        await stopAfterFailedHealthCheck(server);
        return { _tag: "local-api-unavailable" };
      }

      if (!isHealthy) {
        await stopAfterFailedHealthCheck(server);
        return { _tag: "local-api-unavailable" };
      }

      try {
        await dependencies.showWorkbench(server);
      } catch (cause: unknown) {
        await dependencies.localApi.stop(server);
        activeServer = undefined;
        throw cause;
      }

      return { _tag: "started" };
    },
    async stop(): Promise<void> {
      if (activeServer === undefined) {
        return;
      }

      const server = activeServer;
      activeServer = undefined;
      await dependencies.localApi.stop(server);
    },
  };

  async function stopAfterFailedHealthCheck(
    server: StartedLocalApi,
  ): Promise<void> {
    activeServer = undefined;
    try {
      await dependencies.localApi.stop(server);
    } catch {
      // A failed health check already makes startup terminal; do not leak cleanup details into Electron.
    }
  }
}

const UPGRADE_REFUSAL_COPY = {
  profile_unreadable: {
    problem: "The workspace profile file cannot be read.",
    action: "Restore a good copy of this file, or remove it.",
  },
  catalog_damaged: {
    problem: "The local repository list is damaged.",
    action: "Restore a good copy of this file.",
  },
  catalog_mismatch: {
    problem: "The local repository list does not match the workspace profile.",
    action: "Restore this file and the profile from the same backup.",
  },
  conflicting_registrations: {
    problem: "The profile gives one repository two different checkout paths.",
    action: "Edit this file so each repository has one path.",
  },
  review_unreadable: {
    problem: "A saved Local Review cannot be read.",
    action: "Restore a good copy of this file, or move it out of the folder.",
  },
  backup_conflict: {
    problem: "An earlier upgrade backup differs from the current profile.",
    action:
      "Move this backup aside if the current profile is the copy to keep.",
  },
  inputs_changed: {
    problem: "A file changed while Patchdesk was upgrading.",
    action: "Quit other Patchdesk processes, then start Patchdesk again.",
  },
  upgrade_locked: {
    problem: "Another Patchdesk process may be upgrading this profile.",
    action:
      "Quit other Patchdesk processes. If none is running, remove this folder.",
  },
  storage_unavailable: {
    problem: "Patchdesk could not read or write this location.",
    action: "Check its permissions and free disk space.",
  },
} satisfies Record<
  UpgradeRefusalReason,
  { readonly problem: string; readonly action: string }
>;

/** The startup dialog text for a refused profile upgrade; it names the file to act on. */
export function upgradeRefusalMessage(
  detail: UpgradeRefusal,
  roots: {
    readonly configDirectory: () => string;
    readonly dataDirectory: () => string;
  },
): string {
  const copy = UPGRADE_REFUSAL_COPY[detail.reason];
  const locate = (file: UpgradeRefusalFile) =>
    join(
      file.root === "config" ? roots.configDirectory() : roots.dataDirectory(),
      file.path,
    );
  const profileFile =
    detail.profileId === undefined
      ? undefined
      : locate({
          root: "config",
          path: join("profiles", `${detail.profileId}.json`),
        });
  return [
    copy.problem,
    ...(detail.profileId === undefined ? [] : [`Profile: ${detail.profileId}`]),
    `File: ${locate(detail.file)}`,
    `Reason: ${detail.reason} (${detail.storageReason})`,
    ...(detail.backup !== undefined
      ? [`Profile backup before the upgrade: ${locate(detail.backup)}`]
      : profileFile === undefined || profileFile === locate(detail.file)
        ? []
        : [`No backup was made. Profile file: ${profileFile}`]),
    `What to do: ${copy.action} Then start Patchdesk again.`,
    "No review or GitHub write was started.",
  ].join("\n");
}
