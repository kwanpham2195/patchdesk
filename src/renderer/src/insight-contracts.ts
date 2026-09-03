import * as v from "valibot";

import type { InsightProvider } from "../../domain/insight-provider";

/** What each provider is called wherever a retained Insight states its provenance. */
export const INSIGHT_PROVIDER_LABELS = {
  pi: "API key",
  "codex-cli-account": "Codex CLI account",
} as const satisfies Record<InsightProvider, string>;

/**
 * The parts of an Insight projection that are the same for every Insight type,
 * so a new type (Brief, in `brief-contracts.ts`) reuses the envelope instead of
 * restating it. Only the retained `value` differs per type; everything here is
 * the run lifecycle around it.
 *
 * These live beside `renderer-contracts.ts` rather than inside it because that
 * file is at the size ratchet's ceiling, and because a schema module that
 * imports it back would close an import cycle.
 */
export const insightFields = {
  status: v.picklist([
    "not_generated",
    "running",
    "current",
    "outdated",
    "failed",
  ]),
  artifactStatus: v.optional(v.picklist(["verified", "mismatch"])),
  activeRun: v.optional(
    v.strictObject({
      runId: v.optional(v.pipe(v.string(), v.minLength(1))),
      sessionId: v.pipe(v.string(), v.minLength(1)),
      startedAt: v.pipe(v.string(), v.isoTimestamp()),
    }),
  ),
  replacementFailure: v.optional(
    v.strictObject({
      runId: v.optional(v.pipe(v.string(), v.minLength(1))),
      category: v.optional(
        v.picklist([
          "authentication_required",
          "rate_limited",
          "runtime_unavailable",
          "timed_out",
          "execution_failed",
          "invalid_result",
          "unexpected_failure",
        ]),
      ),
      model: v.pipe(v.string(), v.minLength(1)),
      reasoning: v.picklist(["minimal", "low", "medium", "high", "xhigh"]),
      retryable: v.boolean(),
    }),
  ),
  progress: v.optional(
    v.strictObject({
      reviewedSectionIds: v.array(v.pipe(v.string(), v.minLength(1))),
      supportReviewed: v.boolean(),
      currentSectionId: v.optional(v.pipe(v.string(), v.minLength(1))),
    }),
  ),
} as const;

/**
 * The envelope around one retained Insight value: which run produced it, for
 * which revision, and with which provider and model. `provenance` is optional
 * here because a record retained before it was projected carries none; a
 * Provenance panel shows what it has rather than refusing the whole document.
 */
export const retainedInsightFields = {
  runId: v.optional(v.pipe(v.string(), v.minLength(1))),
  sessionId: v.pipe(v.string(), v.minLength(1)),
  headSha: v.pipe(v.string(), v.minLength(7)),
  generatedAt: v.pipe(v.string(), v.isoTimestamp()),
  provenance: v.optional(
    v.strictObject({
      provider: v.picklist(["pi", "codex-cli-account"]),
      model: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
      reasoning: v.picklist(["minimal", "low", "medium", "high", "xhigh"]),
    }),
  ),
} as const;
