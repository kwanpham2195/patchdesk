import type {
  GuidePreparationInput,
  GuidePreparationResult,
} from "./insight-artifact-job-protocol";
import { prepareExplanationInputs } from "./insight-explanation-preparation-job";

/** Captures Walkthrough evidence and its exact hunk index without admitting provider work. */
export function prepareWalkthroughInputs(
  input: GuidePreparationInput,
  options: { readonly signal?: AbortSignal } = {},
): Promise<GuidePreparationResult> {
  return prepareExplanationInputs("walkthrough", input, options);
}
