import { defineAgent, defineWorkflow } from "@flue/runtime";

import type { FlueHarness } from "../flue-runtime-types";
import {
  parseWalkthroughOutput,
  prepareWalkthroughPrompt,
  walkthroughInputSchema,
  walkthroughOutputSchema,
  type InvalidWalkthroughOutput,
  type WalkthroughInput,
  type WalkthroughOutput,
} from "../services/walkthrough-operation";

export {
  parseWalkthroughOutput,
  walkthroughInputSchema,
  walkthroughOutputSchema,
  type InvalidWalkthroughOutput,
  type WalkthroughInput,
  type WalkthroughOutput,
};

const walkthroughAgent = defineAgent(() => ({
  instructions: "Create a concise semantic explanation of one immutable pull-request patch. Return only the required structured result.",
  model: "opencode-go/deepseek-v4-flash",
  skills: [],
}));

/** Beta wrapper retained only until the Plan 006 production composition switch. */
export async function runWalkthroughWorkflow({ harness, input }: { readonly harness: FlueHarness; readonly input: WalkthroughInput }): Promise<WalkthroughOutput> {
  const prompt = await prepareWalkthroughPrompt(input);
  const session = await harness.session();
  const response = await session.prompt<WalkthroughOutput>(prompt, {
    result: walkthroughOutputSchema,
    tools: [],
    model: input.model,
    thinkingLevel: input.reasoning,
  });
  const parsed = parseWalkthroughOutput(response.data);
  if (parsed._tag === "err") throw new Error("Invalid walkthrough result");
  return parsed.value;
}

export default defineWorkflow({
  agent: walkthroughAgent,
  input: walkthroughInputSchema,
  output: walkthroughOutputSchema,
  run: runWalkthroughWorkflow,
});
