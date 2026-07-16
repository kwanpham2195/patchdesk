import type * as v from "valibot";

/**
 * SAFETY: Flue beta.9's published root declaration re-exports a `.d.mts` file in a form
 * TypeScript rejects. This provides the small schema-checked surface Patchdesk uses while
 * Vite and Flue continue resolving the runtime import through the package export.
 */
export type AgentDefinition = { readonly __flueAgentDefinition: true };

/** Represents a discovered Flue workflow definition. */
export type WorkflowDefinition = { readonly __flueWorkflowDefinition: true };

export type ToolDefinition<TInput = unknown, TOutput = unknown> = {
  readonly name: string;
  readonly description: string;
  run(context: { readonly input: TInput; readonly signal?: AbortSignal }): TOutput | Promise<TOutput>;
};

export type FlueHarness = {
  session(): Promise<{
    prompt<T>(text: string, options: {
      readonly result: v.GenericSchema;
      readonly tools: ReadonlyArray<ToolDefinition>;
    }): Promise<{ readonly data: T }>;
  }>;
};

/** Types the narrow model-callable tool surface Patchdesk exposes. */
export declare function defineTool<TInput extends v.GenericSchema, TOutput extends v.GenericSchema>(configuration: {
  readonly name: string;
  readonly description: string;
  readonly input: TInput;
  readonly output: TOutput;
  run(context: { readonly input: v.InferOutput<TInput>; readonly signal?: AbortSignal }): v.InferOutput<TOutput> | Promise<v.InferOutput<TOutput>>;
}): ToolDefinition<v.InferOutput<TInput>, v.InferOutput<TOutput>>;

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
    readonly harness: FlueHarness;
  }): v.InferInput<TOutput> | Promise<v.InferInput<TOutput>>;
}): WorkflowDefinition;
