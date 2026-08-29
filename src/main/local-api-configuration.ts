import {
  minLength,
  object,
  optional,
  picklist,
  pipe,
  string,
  type InferOutput,
} from "valibot";

import type { AppCapability } from "./ipc-contract";
import type { PatchdeskPaths } from "../adapters/storage/patchdesk-paths";
import type { TrashMover } from "../services/storage-management-service";
import type { GitHubCredentials } from "../adapters/github/github-credentials";
import type {
  GitHubMergeWriter,
  GitHubReader,
  GitHubReviewWriter,
} from "../adapters/github/github-adapter";
import type { OriginFinder } from "../services/dashboard-service";
import type { ReviewLifecycleGate } from "../services/review-lifecycle-gate";
import type { ReviewOperationCoordinator } from "../services/review-operation-coordinator";
import type { ReviewDiagnosticService } from "../services/review-diagnostic-service";
import type { AppLogService } from "../services/app-log-service";
import type { AvatarFetcher } from "../services/avatar-sync-service";
import type { InsightRunCoordinator } from "../services/insight-run-coordinator";
import type { InsightProviderCatalog } from "../services/insight-provider-catalog";
import type { PiRuntimeModelCatalog } from "../adapters/pi/pi-runtime-model-catalog";
import type { GitReadExecutor } from "../services/review-worktree-service";

export const localApiConfigurationSchema = object({
  allowedOrigin: pipe(string(), minLength(1)),
  developmentOrigin: optional(pipe(string(), minLength(1))),
  capability: pipe(string(), minLength(1)),
  appMetadata: optional(
    object({
      productName: pipe(string(), minLength(1)),
      version: pipe(string(), minLength(1)),
      architecture: pipe(string(), minLength(1)),
      distribution: picklist(["development", "unsigned_internal"]),
    }),
  ),
});

/** Configuration required to bind the authenticated loopback API. */
export type LocalApiConfiguration = {
  readonly allowedOrigin: string;
  /** Vite's fixed renderer origin, accepted only by the unpackaged desktop app. */
  readonly developmentOrigin?: string | undefined;
  readonly capability: AppCapability;
  readonly appMetadata?:
    | {
        readonly productName: string;
        readonly version: string;
        readonly architecture: string;
        readonly distribution: "development" | "unsigned_internal";
      }
    | undefined;
  /** Explicit seams used only by local integration tests; production uses real main-process adapters. */
  readonly github?: GitHubReader;
  /** Test-only write seam. A reader alone must never enable review-write routes. */
  readonly reviewWriter?: GitHubReviewWriter;
  /** Test-only merge seam. Production gets this capability from the main-process adapter. */
  readonly mergeWriter?: GitHubMergeWriter;
  readonly origins?: OriginFinder;
  readonly paths?: PatchdeskPaths;
  /** Main-process-only source of currently enabled Pi models. */
  readonly modelCatalog?: PiRuntimeModelCatalog;
  /** Main-process-only provider catalog; Codex activation is explicit and authenticated. */
  readonly insightProviders?: Pick<
    InsightProviderCatalog,
    "passive" | "activateCodex"
  >;
  /** Main-process-owned Trash capability. Production wires shell.trashItem. */
  readonly trash?: TrashMover;
  /** Test-only read-only git seam used by storage cache clear. */
  readonly readOnlyGit?: GitReadExecutor;
  /** Test-only profile credential seam; production resolves the configured gh account. */
  readonly githubCredentials?: GitHubCredentials;
  /**
   * Test-only `gh` executable resolver seam. Production discovers `gh` fresh
   * on every managed fetch (via `discoverExecutable`, which adds the macOS
   * Desktop PATH fallback) so a credential helper Git spawns through
   * `/bin/sh` can find it even when Electron was launched from Finder.
   */
  readonly resolveGitHubCli?: () => Promise<string | undefined>;
  /** Composition-root lifecycle gate shared by every durable review mutation. */
  readonly lifecycleGate?: ReviewLifecycleGate;
  /** Composition-root coordinator shared by all Review-scoped mutations. */
  readonly reviewOperations?: ReviewOperationCoordinator;
  /** Composition-root diagnostic service shared by every failure boundary. */
  readonly diagnostics?: ReviewDiagnosticService;
  /** Composition-root local log stream; defaults to a fresh on-disk service. */
  readonly logs?: Pick<AppLogService, "write" | "tail">;
  /** Test-only avatar download seam; production keeps the real network fetcher. */
  readonly fetchAvatar?: AvatarFetcher;
  /** Main-process-owned durable Review Insight lifecycle seam. */
  readonly insights?: Pick<
    InsightRunCoordinator,
    "start" | "cancel" | "observe" | "dismissFinding"
  > &
    Partial<
      Pick<InsightRunCoordinator, "updateWalkthroughProgress" | "addFinding">
    >;
  /**
   * Enables the automatic retention sweep after startup and every 24 hours.
   * Main-process-only; local integration tests keep it off.
   */
  readonly retentionSweep?: boolean;
};

/** The subset of the configuration the loopback API validates before it binds. */
export type ParsedLocalApiConfiguration = InferOutput<
  typeof localApiConfigurationSchema
>;
