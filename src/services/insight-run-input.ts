import type { InsightActivitySink } from "#src/adapters/codex/codex-activity";
import type { CodexAnalysisCommandFailure } from "#src/adapters/codex/codex-analysis-command-diagnostic";
import type {
  GitSha,
  InsightRunId,
  ReviewId,
  ReviewSessionId,
  WorkspaceProfileId,
} from "#src/domain/ids";
import type { InsightEvidenceBundle } from "#src/domain/insight-evidence";
import type {
  InsightFailureCategory,
  InsightType,
} from "#src/domain/insight-record";
import type {
  InsightProvider,
  InsightReasoning,
  InsightLanguage,
} from "#src/domain/insight-provider";
import type { Result } from "#src/domain/result";
import type { PreparedGuide } from "./guide-operation";

/** Provider input; coordinator-prepared runs additionally carry their parent-held evidence bundle. */
export type InsightInvocationInput = {
  readonly profileId: WorkspaceProfileId;
  readonly reviewId: ReviewId;
  readonly sessionId: ReviewSessionId;
  readonly runId: InsightRunId;
  readonly type: InsightType;
  readonly expectedHeadSha: GitSha;
  readonly contextPath: string;
  readonly reviewInputPath?: string;
  readonly patchPath: string;
  readonly worktreePath: string;
  readonly provider: InsightProvider;
  readonly model: string;
  readonly reasoning: InsightReasoning;
  readonly language: InsightLanguage;
  readonly guide?: PreparedGuide;
  readonly evidence?: InsightEvidenceBundle;
};
/** Provider-classified failure; cancellation remains distinct from failure. */
type InsightInvocationFailure = {
  readonly reason: InsightFailureCategory | "cancelled";
  readonly phase?: string;
  readonly code?: string;
  readonly detail?: string;
  readonly stderr?: string;
};
/** Per-invocation lifetime and optional provider activity reporting. */
export type InsightInvocationOptions = {
  readonly signal: AbortSignal;
  readonly onActivity?: InsightActivitySink | undefined;
  /** Receives only the first Codex Analysis command failure's closed diagnostic projection. */
  readonly onAnalysisCommandFailure?:
    | ((failure: CodexAnalysisCommandFailure) => void)
    | undefined;
};
/** Invokers leave result validation to the executor. */
export type InsightInvoker = {
  invoke(
    input: InsightInvocationInput,
    options: InsightInvocationOptions,
  ): Promise<Result<unknown, InsightInvocationFailure>>;
};
