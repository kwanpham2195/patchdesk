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

/** Languages an Insight's human-readable text can be written in; English is the default. */
export const INSIGHT_LANGUAGES = ["en", "vi"] as const;
export type InsightLanguage = (typeof INSIGHT_LANGUAGES)[number];

/** A provider/model/reasoning/language value saved as run provenance. */
export type InsightProvenance = InsightSelection & {
  readonly language: InsightLanguage;
};

/** Parses a bounded provider identifier from a transport or storage boundary. */
export function parseInsightProvider(
  input: unknown,
): Result<InsightProvider, "invalid_provider"> {
  if (input === "pi" || input === "codex-cli-account") return ok(input);
  return err("invalid_provider");
}

/** Parses a bounded reasoning identifier from a transport or storage boundary. */
export function parseInsightReasoning(
  input: unknown,
): Result<InsightReasoning, "invalid_reasoning"> {
  if (
    input === "minimal" ||
    input === "low" ||
    input === "medium" ||
    input === "high" ||
    input === "xhigh"
  )
    return ok(input);
  return err("invalid_reasoning");
}
