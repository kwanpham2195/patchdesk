import { net } from "electron";
import { safeParse } from "valibot";

import {
  localApiConfigurationSchema,
  type LocalApiConfiguration,
  type ParsedLocalApiConfiguration,
} from "./local-api-configuration";
import { PatchdeskPaths } from "../adapters/storage/patchdesk-paths";
import { ProfileStore } from "../adapters/storage/profile-store";
import { ReviewSessionStore } from "../adapters/storage/review-session-store";
import { ReviewStore } from "../adapters/storage/review-store";
import { ReviewRemoteStore } from "../adapters/storage/review-remote-store";
import { ReviewObservationJournalStore } from "../adapters/storage/review-observation-journal-store";
import { RecentWriteJournalStore } from "../adapters/storage/recent-write-journal-store";
import { MergeOperationStore } from "../adapters/storage/merge-operation-store";
import { ReviewWriteOperationStore } from "../adapters/storage/review-write-operation-store";
import { ReviewArtifactStorage } from "../adapters/storage/review-artifact-storage";
import { InsightStore } from "../adapters/storage/insight-store";
import { WatchedPullRequestStore } from "../adapters/storage/watched-pull-request-store";
import { StorageManagementService } from "../services/storage-management-service";
import { GitHubAdapter } from "../adapters/github/github-adapter";
import type { GitHubReader } from "../adapters/github/github-adapter";
import {
  GitHubCliCredentials,
  type GitHubCredentials,
} from "../adapters/github/github-credentials";
import {
  GitHubHttpClient,
  type GitHubFetch,
} from "../adapters/github/github-http-client";
import { TransportShadow } from "../adapters/github/transport-shadow";
import {
  CommandRunner,
  NodeCommandExecutor,
  type CommandRequest,
} from "../adapters/github/command-runner";
import { discoverExecutable } from "../adapters/process/executable-discovery";
import { systemNow } from "../adapters/process/system-clock";
import { AppLogService } from "../services/app-log-service";
import { ReviewLifecycleGate } from "../services/review-lifecycle-gate";
import { ReviewDiagnosticService } from "../services/review-diagnostic-service";
import { ReviewWriteGate } from "../services/review-write-gate";
import type { GitReadExecutor } from "../services/review-worktree-service";
import { parseWorkspaceProfileId } from "../domain/ids";
import { err, ok } from "../domain/result";

const defaultGitReadTimeoutMs = 15_000;
const managedFetchTimeoutMs = 120_000;

/** Creates the main-process Git seam with profile environments and a longer managed-fetch timeout. */
export function createReadOnlyGitExecutor(
  commands: Pick<CommandRunner, "runText">,
): GitReadExecutor {
  return {
    async run(
      argv: ReadonlyArray<string>,
      environment?: Readonly<Record<string, string>>,
    ) {
      let request: CommandRequest = {
        argv,
        timeoutMs: argv.includes("fetch")
          ? managedFetchTimeoutMs
          : defaultGitReadTimeoutMs,
      };
      if (environment !== undefined) request = { ...request, environment };
      const output = await commands.runText(request);
      return output._tag === "ok"
        ? ok({ stdout: output.value })
        : err({ _tag: "GitReadFailed" as const });
    },
  };
}

/**
 * The shadow comparison of the HTTP transport against gh, when this launch
 * asked for one with `PATCHDESK_TRANSPORT_SHADOW=1` (issue #292). It doubles
 * read traffic against the same rate limit, so it is read here, once, rather
 * than consulted per call.
 */
function transportShadow(
  credentials: GitHubCredentials,
  logs: Pick<AppLogService, "write">,
): TransportShadow | undefined {
  if (process.env["PATCHDESK_TRANSPORT_SHADOW"] !== "1") return undefined;
  return new TransportShadow(
    new GitHubHttpClient(credentials, undefined, undefined, chromiumFetch),
    credentials,
    (entry) => logs.write(entry),
  );
}

/**
 * The GitHub HTTP client's way onto the network: Chromium's stack, which
 * honours the system proxy and the system trust store that `gh` honoured and
 * Node's fetch does not (ADR 0046). This is the composition root, the only
 * layer allowed to know about Electron.
 *
 * Both options are load-bearing and were measured against Electron 43 rather
 * than assumed. `cache: "no-store"` keeps Chromium's HTTP cache out of the
 * path: GitHub answers an authenticated read with `Cache-Control: private,
 * max-age=60`, and by default a repeat call within that minute is served from
 * the cache without reaching GitHub. `credentials: "omit"` keeps the default
 * session's cookie jar out of it; by default a cookie GitHub set on one
 * response is sent back on the next. The bearer token is a header this client
 * sets itself, so neither is needed to authenticate.
 */
const chromiumFetch: GitHubFetch = (url, init) =>
  net.fetch(url, { ...init, cache: "no-store", credentials: "omit" });

/** Every store, adapter and seam the loopback API's services are built from. */
export type LocalApiStores = {
  readonly parsedConfiguration: {
    readonly output: ParsedLocalApiConfiguration;
  };
  readonly paths: PatchdeskPaths;
  readonly logs: Pick<AppLogService, "write" | "tail">;
  readonly commands: CommandRunner;
  readonly credentials: GitHubCredentials;
  readonly github: GitHubReader;
  readonly readOnlyGit: GitReadExecutor;
  readonly resolveGitHubCli: () => Promise<string | undefined>;
  readonly diagnostics: ReviewDiagnosticService;
  readonly profiles: ProfileStore;
  recordProfileReloadFailure(phase: string): Promise<void>;
  readonly sessions: ReviewSessionStore;
  readonly reviews: ReviewStore;
  readonly remoteReviews: ReviewRemoteStore;
  readonly observationJournals: ReviewObservationJournalStore;
  readonly recentWriteJournals: RecentWriteJournalStore;
  readonly reviewWriteGate: ReviewWriteGate;
  readonly storageArtifacts: ReviewArtifactStorage;
  readonly lifecycleGate: ReviewLifecycleGate;
  readonly insights: InsightStore;
  readonly watchedPullRequests: WatchedPullRequestStore;
  readonly storageManagement: StorageManagementService;
};

/** Either the built stores, or the startup refusal that stopped them. */
export type LocalApiStoresResult =
  | { readonly _tag: "ok"; readonly stores: LocalApiStores }
  | { readonly _tag: "invalid-configuration" }
  | { readonly _tag: "recovery-failed" };

/** Builds the storage and adapter layer the local API's services depend on. */
export async function buildLocalApiStores(
  configuration: LocalApiConfiguration,
): Promise<LocalApiStoresResult> {
  const parsedConfiguration = safeParse(
    localApiConfigurationSchema,
    configuration,
  );
  if (!parsedConfiguration.success) {
    return { _tag: "invalid-configuration" };
  }

  const paths = configuration.paths ?? PatchdeskPaths.default();
  const logs = configuration.logs ?? new AppLogService(paths);
  // Every slow operation in this app is a child process; this is the only
  // place that counts them, so `scripts/gh-spawn-report.mjs` can tell which
  // endpoints a route spawned and how often it repeated one.
  const executor = new NodeCommandExecutor(undefined, undefined, (record) => {
    logs.write({
      process: "main",
      level: "debug",
      topic: "command-spawn",
      message: `${record.executable} ${record.label}`,
      meta: {
        executable: record.executable,
        label: record.label,
        durationMs: record.durationMs,
        outcome: record.outcome,
        exitCode: record.exitCode,
      },
    });
  });
  const commands = new CommandRunner(executor, (stderr) => {
    // Fires only when a nonzero-exit command failure matched neither a
    // structured signal nor any regex predicate — genuine gh-wording drift
    // worth a human noticing. AppLogService.write already masks credential
    // shapes and bounds message length.
    logs.write({
      process: "main",
      level: "warn",
      topic: "command-runner",
      message: "unclassified command failure",
      meta: { stderr },
    });
  });
  const credentials =
    configuration.githubCredentials ?? new GitHubCliCredentials(commands);
  const github =
    configuration.github ??
    new GitHubAdapter(
      commands,
      credentials,
      transportShadow(credentials, logs),
    );
  const readOnlyGit = createReadOnlyGitExecutor(commands);
  const resolveGitHubCli =
    configuration.resolveGitHubCli ?? (() => discoverExecutable("gh"));
  const diagnostics =
    configuration.diagnostics ??
    new ReviewDiagnosticService(paths, () => new Date().toISOString());
  const profiles = new ProfileStore(paths);
  const recordProfileReloadFailure = async (phase: string): Promise<void> => {
    const config = await profiles.loadConfig();
    if (
      config._tag !== "ok" ||
      config.value.lastSelectedProfileId === undefined
    )
      return;
    const profileId = parseWorkspaceProfileId(
      config.value.lastSelectedProfileId,
    );
    if (profileId._tag !== "ok") return;
    await diagnostics.record({
      profileId: profileId.value,
      category: "recovery",
      phase,
      retryable: true,
      detail: "The selected profile could not reload its workspace data.",
    });
  };
  const sessions = new ReviewSessionStore(paths);
  const reviews = new ReviewStore(paths);
  const remoteReviews = new ReviewRemoteStore(paths);
  const observationJournals = new ReviewObservationJournalStore(paths);
  const recentWriteJournals = new RecentWriteJournalStore(paths, logs);
  const reviewWriteGate = new ReviewWriteGate(
    profiles,
    reviews,
    sessions,
    remoteReviews,
    observationJournals,
  );
  const storageArtifacts = new ReviewArtifactStorage(paths, systemNow);
  const lifecycleGate =
    configuration.lifecycleGate ?? new ReviewLifecycleGate();
  const insights = new InsightStore(paths);
  const storageManagementInput = {
    profiles,
    sessions,
    reviews,
    insights,
    mergeOperations: new MergeOperationStore(paths),
    writeOperations: new ReviewWriteOperationStore(paths),
    artifacts: storageArtifacts,
    paths,
    lifecycleGate,
    diagnostics,
    git: configuration.readOnlyGit ?? readOnlyGit,
    now: systemNow,
  };
  const storageManagement = new StorageManagementService(
    configuration.trash === undefined
      ? storageManagementInput
      : { ...storageManagementInput, trash: configuration.trash },
  );

  return {
    _tag: "ok",
    stores: {
      parsedConfiguration,
      paths,
      logs,
      commands,
      credentials,
      github,
      readOnlyGit,
      resolveGitHubCli,
      diagnostics,
      profiles,
      recordProfileReloadFailure,
      sessions,
      reviews,
      remoteReviews,
      observationJournals,
      recentWriteJournals,
      reviewWriteGate,
      storageArtifacts,
      lifecycleGate,
      insights,
      watchedPullRequests: new WatchedPullRequestStore(paths),
      storageManagement,
    },
  };
}
