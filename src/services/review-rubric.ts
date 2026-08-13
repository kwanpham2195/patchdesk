/** Builds a full represented-revision Analysis prompt. */
export function composeReviewPrompt(input: { readonly reviewInput: string; readonly context: string; readonly fullPatch: string }): string {
  return ["Review the complete represented pull request.", input.reviewInput, input.context, input.fullPatch].join("\n\n");
}
