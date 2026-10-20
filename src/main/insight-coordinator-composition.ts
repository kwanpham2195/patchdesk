import { app } from "electron";

import { CodexAppServerClient } from "#src/adapters/codex/codex-app-server-client";
import { CommandRunner } from "#src/adapters/github/command-runner";
import type { GitHubReader } from "#src/adapters/github/github-adapter";
import type { LocalPiRuntimeModelCatalog } from "#src/adapters/pi/pi-runtime-model-catalog";
import { PiRpcClient } from "#src/adapters/pi-cli/pi-rpc-client";
import { discoverPathOnlyExecutable } from "#src/adapters/process/executable-discovery";
import { InsightStore } from "#src/adapters/storage/insight-store";
import type { PatchdeskPaths } from "#src/adapters/storage/patchdesk-paths";
import { ProfileStore } from "#src/adapters/storage/profile-store";
import { ReviewSessionStore } from "#src/adapters/storage/review-session-store";
import { ReviewStore } from "#src/adapters/storage/review-store";
import { parseGitSha } from "#src/domain/ids";
import type {
  AccountInsightProvider,
  InsightProvider,
} from "#src/domain/insight-provider";
import { err } from "#src/domain/result";
import {
  AccountInsightInvoker,
  type AccountInsightRunner,
} from "#src/services/account-insight-invoker";
import type { AppLogService } from "#src/services/app-log-service";
import { briefReachComputer } from "#src/services/brief-reach-service";
import type { DesktopNotifier } from "#src/services/desktop-notifier";
import type { InsightProviderCatalog } from "#src/services/insight-provider-catalog";
import type { InsightResourceBundle } from "#src/services/insight-resource-bundle";
import {
  currentIsoTimestamp as now,
  InsightRunCoordinator,
  type InsightInvoker,
} from "#src/services/insight-run-coordinator";
import { InsightSlotAuthority } from "#src/services/insight-slot-authority";
import {
  PiInsightChildInvoker,
  unavailablePiInsightInvoker,
} from "#src/services/pi-insight-child-invoker";
import { ReviewContextPackService } from "#src/services/review-context-pack-service";
import { ReviewContextService } from "#src/services/review-context-service";
import type { ReviewDiagnosticService } from "#src/services/review-diagnostic-service";
import type { ReviewOperationCoordinator } from "#src/services/review-operation-coordinator";
import { resolveInsightRuntime } from "./insight-runtime";
import { createReadOnlyGitExecutor } from "./local-api-stores";

/** The process-wide objects electron-main.ts owns and the coordinator's construction reads. */
type InsightCoordinatorHost = {
  readonly paths: PatchdeskPaths;
  readonly logs: AppLogService;
  readonly logUnclassifiedCommandFailure: (stderr: string) => void;
  readonly diagnostics: ReviewDiagnosticService;
  readonly desktopNotifier: DesktopNotifier;
};

/** Binds the host objects once; each call builds one coordinator with the same wiring as before the move. */
export function insightCoordinatorFactory({
  paths,
  logs,
  logUnclassifiedCommandFailure,
  diagnostics,
  desktopNotifier,
}: InsightCoordinatorHost) {
  return (
    modelCatalog: LocalPiRuntimeModelCatalog,
    providerCatalog: InsightProviderCatalog,
    operations: ReviewOperationCoordinator,
    github: GitHubReader,
    { authorityReader: reader }: InsightResourceBundle,
  ): InsightRunCoordinator => {
    const runtime = resolveInsightRuntime(
      app.getAppPath(),
      process.cwd(),
      app.isPackaged,
    );
    logs.write({
      process: "main",
      level: runtime === undefined ? "warn" : "info",
      topic: "insight-runtime",
      message:
        runtime === undefined
          ? "no verified Insight runtime resolved"
          : `Insight runtime resolved from the ${runtime.kind} build`,
      meta: runtime === undefined ? {} : { runnerPath: runtime.runnerPath },
    });
    const readHead = async (
      worktreePath: string,
    ): Promise<string | undefined> => {
      const output = await new CommandRunner(
        undefined,
        logUnclassifiedCommandFailure,
      ).runText({
        argv: ["git", "-C", worktreePath, "rev-parse", "HEAD"],
        cwd: worktreePath,
        timeoutMs: 10_000,
      });
      if (output._tag === "err") return undefined;
      const parsed = parseGitSha(output.value.trim());
      return parsed._tag === "ok" ? parsed.value : undefined;
    };
    /**
     * An account provider's CLI is discovered per run rather than once here: the
     * executable can appear or move between runs, and a PATH lookup is cheaper
     * than a run.
     */
    const accountInvoker = (
      provider: AccountInsightProvider,
      executable: string,
      clientFactory: (executablePath: string) => AccountInsightRunner,
    ): InsightInvoker => ({
      async invoke(input, options) {
        const executablePath = await discoverPathOnlyExecutable(executable);
        if (executablePath === undefined)
          return err({ reason: "runtime_unavailable" as const });
        return new AccountInsightInvoker(
          provider,
          paths,
          clientFactory,
          executablePath,
          readHead,
        ).invoke(input, options);
      },
    });
    const providerInvokers = {
      pi:
        runtime === undefined
          ? unavailablePiInsightInvoker
          : new PiInsightChildInvoker(
              new CommandRunner(undefined, logUnclassifiedCommandFailure),
              runtime.root,
              process.execPath,
              runtime.runnerPath,
              undefined,
              paths.rootsEnvironment(),
            ),
      "codex-cli-account": accountInvoker(
        "codex-cli-account",
        "codex",
        (path) => new CodexAppServerClient(path),
      ),
      "pi-cli-account": accountInvoker(
        "pi-cli-account",
        "pi",
        (path) => new PiRpcClient(path),
      ),
    } satisfies Readonly<Record<InsightProvider, InsightInvoker>>;
    /**
     * The one place a provider is chosen. Each run carries the provider it was
     * started with, so the same dispatch serves every Insight type instead of
     * three hand-built objects repeating the same branch.
     */
    const invoker: InsightInvoker = {
      async invoke(input, options) {
        return providerInvokers[input.provider].invoke(input, options);
      },
    };
    const store = new InsightStore(paths, reader);
    const slots = new InsightSlotAuthority(
      paths,
      reader,
      store,
      operations,
      now,
    );
    return new InsightRunCoordinator(
      new ReviewStore(paths),
      new ReviewSessionStore(paths),
      store,
      paths,
      modelCatalog,
      {
        analysis: invoker,
        walkthrough: invoker,
        brief: invoker,
        guide: invoker,
      },
      operations,
      new ReviewContextPackService({
        profiles: new ProfileStore(paths),
        github,
        context: new ReviewContextService(),
        paths,
        git: createReadOnlyGitExecutor(
          new CommandRunner(undefined, logUnclassifiedCommandFailure),
        ),
      }),
      slots,
      now,
      diagnostics,
      providerCatalog,
      briefReachComputer(
        paths,
        new CommandRunner(undefined, logUnclassifiedCommandFailure),
      ),
      { notifier: desktopNotifier, profiles: new ProfileStore(paths) },
    );
  };
}
