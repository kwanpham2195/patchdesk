import { err, ok, type Result } from "./result";

/** Providers that may execute an Insight: an API key through Pi, or a login an external CLI owns. */
export const INSIGHT_PROVIDERS = [
  "pi",
  "codex-cli-account",
  "pi-cli-account",
] as const;
export type InsightProvider = (typeof INSIGHT_PROVIDERS)[number];

/** Providers that run on an external CLI's login and list models only after an explicit action (ADR 0016, ADR 0054). */
export const ACCOUNT_INSIGHT_PROVIDERS = [
  "codex-cli-account",
  "pi-cli-account",
] as const satisfies ReadonlyArray<InsightProvider>;
export type AccountInsightProvider = (typeof ACCOUNT_INSIGHT_PROVIDERS)[number];

/** Whether a provider runs on an external CLI's login. */
export function isAccountInsightProvider(
  provider: InsightProvider,
): provider is AccountInsightProvider {
  return provider !== "pi";
}

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
  const provider = INSIGHT_PROVIDERS.find((candidate) => candidate === input);
  return provider === undefined ? err("invalid_provider") : ok(provider);
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
