export const REVIEW_EXECUTION_PREFERENCE_VERSION = 1;

export type ReviewReasoningPreference = "low" | "medium" | "high";

export type ReviewExecutionPreference = {
  readonly model: string;
  readonly reasoning: ReviewReasoningPreference;
};

function storageKey(profileId: string): string {
  return `patchdesk.review-execution.v${REVIEW_EXECUTION_PREFERENCE_VERSION}.${profileId}`;
}

/** Keep UI-only selections profile scoped and reject malformed browser storage. */
export function loadReviewExecutionPreference(
  profileId: string,
): ReviewExecutionPreference | undefined {
  try {
    const value: unknown = JSON.parse(
      window.localStorage.getItem(storageKey(profileId)) ?? "null",
    );
    if (
      typeof value !== "object" ||
      value === null ||
      !Object.hasOwn(value, "model") ||
      !Object.hasOwn(value, "reasoning")
    ) return undefined;
    const { model, reasoning } = value as Record<string, unknown>;
    return typeof model === "string" && model.length > 0 && model.length <= 200 &&
        (reasoning === "low" || reasoning === "medium" || reasoning === "high")
      ? { model, reasoning }
      : undefined;
  } catch {
    return undefined;
  }
}

export function saveReviewExecutionPreference(
  profileId: string,
  preference: ReviewExecutionPreference,
): void {
  window.localStorage.setItem(storageKey(profileId), JSON.stringify(preference));
}
