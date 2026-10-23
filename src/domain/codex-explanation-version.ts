/** Only these reviewed native contracts may generate a Guide or Walkthrough. */
export const CODEX_EXPLANATION_SUPPORTED_VERSIONS = ["0.163.0"] as const;

/** Fixed application copy; native output never chooses the displayed diagnostic. */
export const CODEX_EXPLANATION_VERSION_MESSAGE =
  "Unsupported Codex version for Guide and Walkthrough";
