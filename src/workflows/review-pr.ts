import { dirname, join } from "node:path";

import { defineAgent, defineWorkflow } from "@flue/runtime";
import * as v from "valibot";

import { CommandRunner } from "../adapters/github/command-runner";
import patchdeskCodeReview from "../skills/patchdesk-code-review/SKILL.md" with { type: "skill" };
import { modelReviewResultSchema } from "../domain/review-result";
import { runModelReview, type ReviewModelSession } from "../services/model-review-runner";

const reviewAgent = defineAgent(() => ({
  instructions:
    "Review one prepared pull request through the supplied read-only inspection tools. Return only schema-backed findings supported by evidence.",
  model: "opencode-go/kimi-k2.7-code",
  skills: [patchdeskCodeReview],
}));

const reviewPrFixtureInput = v.strictObject({
  profileId: v.pipe(v.string(), v.minLength(1)),
  sessionId: v.pipe(v.string(), v.minLength(1)),
  attemptId: v.pipe(v.string(), v.minLength(1)),
  contextPath: v.pipe(v.string(), v.minLength(1)),
  reviewInputPath: v.pipe(v.string(), v.minLength(1)),
  patchPath: v.pipe(v.string(), v.minLength(1)),
  worktreePath: v.pipe(v.string(), v.minLength(1)),
});

/**
 * A finite model operation. It deliberately exposes no route or run stream until Patchdesk
 * can authorize the app capability and exact session/attempt ownership at both boundaries.
 */
export default defineWorkflow({
  agent: reviewAgent,
  input: reviewPrFixtureInput,
  output: modelReviewResultSchema,
  async run({ harness, input }) {
    const commands = new CommandRunner();
    const session = await harness.session();
    return await runModelReview({
      session: session as ReviewModelSession,
      worktreePath: input.worktreePath,
      contextPath: input.contextPath,
      reviewInputPath: input.reviewInputPath,
      debugPath: join(dirname(input.contextPath), "debug.json"),
      async gitShow(argv) {
        const result = await commands.runText({ argv, timeoutMs: 15_000 });
        return result._tag === "ok" ? result.value : "";
      },
    });
  },
});
