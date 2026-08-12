import { err, ok, type Result } from "./result";

/** Providers that may execute an Insight. */
export type InsightProvider = "pi" | "codex-cli-account";

/** Reasoning efforts accepted by the Insight lifecycle. */
export type InsightReasoning = "minimal" | "low" | "medium" | "high" | "xhigh";

/** The immutable provider choice captured when an Insight run starts. */
export type InsightSelection = {
  readonly provider: InsightProvider;
  readonly model: string;
  readonly reasoning: InsightReasoning;
};

/** A provider/model/reasoning value saved as run provenance. */
export type InsightProvenance = InsightSelection;

/** Provenance used only when loading a retained result written by schema v1. */
export type HistoricalInsightProvenance = {
  readonly provider: "pi";
  readonly configuration: "unavailable";
};

/** A retained result's current or historical provenance. */
export type RetainedInsightProvenance = InsightProvenance | HistoricalInsightProvenance;

/** Parses a bounded provider identifier from a transport or storage boundary. */
export function parseInsightProvider(input: unknown): Result<InsightProvider, "invalid_provider"> {
  if (input === "pi" || input === "codex-cli-account") return ok(input);
  return err("invalid_provider");
}

/** Parses a bounded reasoning identifier from a transport or storage boundary. */
export function parseInsightReasoning(input: unknown): Result<InsightReasoning, "invalid_reasoning"> {
  if (input === "minimal" || input === "low" || input === "medium" || input === "high" || input === "xhigh") return ok(input);
  return err("invalid_reasoning");
}

/** Parses a provider/model/reasoning selection without accepting unknown fields. */
export function parseInsightSelection(input: unknown): Result<InsightSelection, "invalid_selection"> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return err("invalid_selection");
  const value = input as { readonly provider?: unknown; readonly model?: unknown; readonly reasoning?: unknown };
  const provider = parseInsightProvider(value.provider);
  const reasoning = parseInsightReasoning(value.reasoning);
  if (provider._tag === "err" || reasoning._tag === "err" || typeof value.model !== "string" || value.model.trim().length < 1 || value.model.length > 200) return err("invalid_selection");
  return ok({ provider: provider.value, model: value.model, reasoning: reasoning.value });
}

/** Returns whether the provider is available for the requested Insight type. */
export function isInsightProvider(input: unknown): input is InsightProvider {
  return input === "pi" || input === "codex-cli-account";
}
