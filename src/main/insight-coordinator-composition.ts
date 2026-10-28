import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PiCliExplanationProducer } from "#src/services/pi-cli-explanation-producer";
import { AccountExplanationProducer } from "#src/services/account-explanation-producer";
import { app } from "electron";

import { CodexAppServerClient } from "#src/adapters/codex/codex-app-server-client";
import { CommandRunner } from "#src/adapters/github/command-runner";
import type { GitHubReader } from "#src/adapters/github/github-adapter";
import { PiRpcClient } from "#src/adapters/pi-cli/pi-rpc-client";
import { discoverPathOnlyExecutable } from "#src/adapters/process/executable-discovery";
import { InsightStore } from "#src/adapters/storage/insight-store";
import type { PatchdeskPaths } from "#src/adapters/storage/patchdesk-paths";
import { ProfileStore } from "#src/adapters/storage/profile-store";
import { ReviewSessionStore } from "#src/adapters/storage/review-session-store";
import { ReviewStore } from "#src/adapters/storage/review-store";
import { parseGitSha } from "#src/domain/ids";
import {
  isAccountInsightProvider,
  type AccountInsightProvider,
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
import { GuideGenerationService } from "#src/services/guide-generation-service";
import type { ExplanationProducers } from "#src/services/explanation-producer";
import { WalkthroughGenerationService } from "#src/services/walkthrough-generation-service";
import { ExplanationPreparationService } from "#src/services/explanation-preparation-service";
import { InsightSlotAuthority } from "#src/services/insight-slot-authority";
import { ReviewContextPackService } from "#src/services/review-context-pack-service";
import { ReviewContextService } from "#src/services/review-context-service";
import type { ReviewDiagnosticService } from "#src/services/review-diagnostic-service";
import type { ReviewOperationCoordinator } from "#src/services/review-operation-coordinator";
import { createReadOnlyGitExecutor } from "./local-api-stores";

/** The process-wide objects electron-main.ts owns and the coordinator's construction reads. */
type InsightCoordinatorHost = {
  readonly paths: PatchdeskPaths;
  readonly logs: AppLogService;
  readonly logUnclassifiedCommandFailure: (stderr: string) => void;
  readonly diagnostics: ReviewDiagnosticService;
  readonly desktopNotifier: DesktopNotifier;
};

/** The one wiring of the context pack over the app's GitHub reader, shared by the coordinator and the Guide preparation diagnostic. */
export function insightContextPackFactory({
  paths,
  logUnclassifiedCommandFailure,
}: Pick<InsightCoordinatorHost, "paths" | "logUnclassifiedCommandFailure">) {
  return (github: GitHubReader): ReviewContextPackService =>
    new ReviewContextPackService({
      profiles: new ProfileStore(paths),
      github,
      context: new ReviewContextService(),
      paths,
      git: createReadOnlyGitExecutor(
        new CommandRunner(undefined, logUnclassifiedCommandFailure),
      ),
    });
}

/** Binds the host objects once; each call builds one coordinator with the same wiring as before the move. */
export function insightCoordinatorFactory({
  paths,
  logs,
  logUnclassifiedCommandFailure,
  diagnostics,
  desktopNotifier,
}: InsightCoordinatorHost) {
  const contextPack = insightContextPackFactory({
    paths,
    logUnclassifiedCommandFailure,
  });
  return (
    providerCatalog: InsightProviderCatalog,
    operations: ReviewOperationCoordinator,
    github: GitHubReader,
    resources: InsightResourceBundle,
  ): InsightRunCoordinator => {
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
          (entry) => logs.write(entry),
        ).invoke(input, options);
      },
    });
    const providerInvokers = {
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
    } satisfies Readonly<Record<AccountInsightProvider, InsightInvoker>>;
    /**
     * The one place a provider is chosen. Each run carries the provider it was
     * started with, so the same dispatch serves every Insight type instead of
     * three hand-built objects repeating the same branch.
     */
    const invoker: InsightInvoker = {
      async invoke(input, options) {
        if (!isAccountInsightProvider(input.provider))
          return err({ reason: "runtime_unavailable" as const });
        return providerInvokers[input.provider].invoke(input, options);
      },
    };
    const reader = resources.authorityReader;
    const store = new InsightStore(paths, reader);
    const slots = new InsightSlotAuthority(
      paths,
      reader,
      store,
      operations,
      now,
    );
    const pack = contextPack(github);
    const codexProducer = new AccountExplanationProducer(
      paths,
      () => discoverPathOnlyExecutable("codex"),
      readHead,
      undefined,
      (entry) => logs.write(entry),
    );
    const piCliProducer = new PiCliExplanationProducer(
      paths,
      () => discoverPathOnlyExecutable("pi"),
      readHead,
      process.execPath,
      app.isPackaged
        ? join(process.resourcesPath, "pi-explanation", "index.mjs")
        : join(
            dirname(fileURLToPath(import.meta.url)),
            "pi-explanation-helper.mjs",
          ),
      (entry) => logs.write(entry),
    );
    const explanationProducers: ExplanationProducers = {
      "codex-cli-account": codexProducer,
      "pi-cli-account": piCliProducer,
    };
    const guide = new GuideGenerationService(
      paths,
      new ExplanationPreparationService(
        paths,
        paths,
        resources,
        operations,
        pack,
        now,
        slots,
      ),
      slots,
      resources,
      explanationProducers,
      now,
      (run, event) => coordinator.recordExplanationActivity(run, event),
    );
    const coordinator = new InsightRunCoordinator(
      new ReviewStore(paths),
      new ReviewSessionStore(paths),
      store,
      paths,
      {
        analysis: invoker,
        walkthrough: invoker,
        brief: invoker,
        guide: invoker,
      },
      operations,
      pack,
      slots,
      now,
      diagnostics,
      providerCatalog,
      briefReachComputer(
        paths,
        new CommandRunner(undefined, logUnclassifiedCommandFailure),
      ),
      { notifier: desktopNotifier, profiles: new ProfileStore(paths) },
      resources.ownership.forScope(paths.dataDirectory()),
      guide,
      new WalkthroughGenerationService(
        paths,
        new ExplanationPreparationService(
          paths,
          paths,
          resources,
          operations,
          pack,
          now,
          slots,
        ),
        slots,
        resources,
        explanationProducers,
        now,
        (run, event) => coordinator.recordExplanationActivity(run, event),
      ),
    );
    return coordinator;
  };
}
