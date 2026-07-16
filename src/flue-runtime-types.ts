import type * as v from "valibot";

/**
 * SAFETY: Flue beta.9's published root declaration re-exports a `.d.mts` file in a form
 * TypeScript rejects. This provides the small schema-checked surface Patchdesk uses while
 * Vite and Flue continue resolving the runtime import through the package export.
 */
export type AgentDefinition = { readonly __flueAgentDefinition: true };

/** Represents a discovered Flue workflow definition. */
export type WorkflowDefinition = { readonly __flueWorkflowDefinition: true };

/** Types the fixture agent declaration without making a model call. */
export declare function defineAgent(
  configuration: () => {
    readonly instructions: string;
    readonly model: string;
    readonly skills: ReadonlyArray<unknown>;
  },
): AgentDefinition;

/** Types the Valibot-validated fixture workflow surface used by Patchdesk. */
export declare function defineWorkflow<
  TInput extends v.GenericSchema,
  TOutput extends v.GenericSchema,
>(configuration: {
  readonly agent: AgentDefinition;
  readonly input: TInput;
  readonly output: TOutput;
  run(context: {
    readonly input: v.InferOutput<TInput>;
  }): v.InferInput<TOutput> | Promise<v.InferInput<TOutput>>;
}): WorkflowDefinition;
