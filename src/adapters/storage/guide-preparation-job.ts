import type {
  GuidePreparationInput,
  GuidePreparationResult,
} from "./insight-artifact-job-protocol";
import { prepareExplanationInputs } from "./insight-explanation-preparation-job";

/** Keeps Guide's prepared codec and evidence identity distinct from Walkthrough. */
export function prepareGuideInputs(
  input: GuidePreparationInput,
  options: { readonly signal?: AbortSignal } = {},
): Promise<GuidePreparationResult> {
  return prepareExplanationInputs("guide", input, options);
}
