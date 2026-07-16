import { defineAgent, defineWorkflow } from "@flue/runtime";
import * as v from "valibot";

import patchdeskCodeReview from "../skills/patchdesk-code-review/SKILL.md" with { type: "skill" };
import { modelReviewResultSchema } from "../domain/review-result";

const fixtureReviewAgent = defineAgent(() => ({
  instructions:
    "This fixture performs no shell, sandbox, GitHub, network, or model operation.",
  model: "openai/gpt-5.5",
  skills: [patchdeskCodeReview],
}));

const reviewPrFixtureInput = v.strictObject({
  profileId: v.pipe(v.string(), v.minLength(1)),
  sessionId: v.pipe(v.string(), v.minLength(1)),
  attemptId: v.pipe(v.string(), v.minLength(1)),
  contextPath: v.pipe(v.string(), v.minLength(1)),
  reviewInputPath: v.pipe(v.string(), v.minLength(1)),
  patchPath: v.pipe(v.string(), v.minLength(1)),
});

/**
 * Exercises current Flue source discovery and schema validation without exposing HTTP routes.
 * Intentionally omits `route` and `runs` exports until session/run ownership enforcement exists.
 */
export default defineWorkflow({
  agent: fixtureReviewAgent,
  input: reviewPrFixtureInput,
  output: modelReviewResultSchema,
  run({ input }) {
    return {
      changeSummary: `Prepared review ${input.sessionId}`,
      verdict: "comment" as const,
      summary: "No model invocation is configured for the deterministic fixture.",
      findings: [],
      validationPlan: [],
      assumptions: ["The app-owned inspector is the only permitted data source."],
    };
  },
});
