import { defineAgent, defineWorkflow } from "@flue/runtime";
import * as v from "valibot";

import patchdeskCodeReview from "../skills/patchdesk-code-review/SKILL.md" with { type: "skill" };

const fixtureReviewAgent = defineAgent(() => ({
  instructions:
    "This fixture performs no shell, sandbox, GitHub, network, or model operation.",
  model: "openai/gpt-5.5",
  skills: [patchdeskCodeReview],
}));

const reviewPrFixtureInput = v.object({
  fixture: v.literal("review-pr"),
  pullRequestNumber: v.pipe(v.number(), v.integer(), v.minValue(1)),
});

const reviewPrFixtureOutput = v.object({
  fixture: v.literal("review-pr"),
  outcome: v.literal("fixture-complete"),
  pullRequestNumber: v.pipe(v.number(), v.integer(), v.minValue(1)),
});

/**
 * Exercises current Flue source discovery and schema validation without exposing HTTP routes.
 * Intentionally omits `route` and `runs` exports until session/run ownership enforcement exists.
 */
export default defineWorkflow({
  agent: fixtureReviewAgent,
  input: reviewPrFixtureInput,
  output: reviewPrFixtureOutput,
  run({ input }) {
    return {
      fixture: input.fixture,
      outcome: "fixture-complete" as const,
      pullRequestNumber: input.pullRequestNumber,
    };
  },
});
