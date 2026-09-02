import { readFile } from "node:fs/promises";

import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { TextContent, ThinkingLevel } from "@earendil-works/pi-ai";
import { toJsonSchema } from "@valibot/to-json-schema";
import * as v from "valibot";

import { briefOutputSchema } from "../../../src/domain/brief";
import { parseReviewSessionId } from "../../../src/domain/ids";
import { modelReviewResultSchema } from "../../../src/domain/review-result";
import { walkthroughOutputSchema } from "../../../src/services/walkthrough-operation";

export const MAX_RUNTIME_STDIN_BYTES = 2 * 1024 * 1024;
export const MAX_RUNTIME_STDOUT_BYTES = 2 * 1024 * 1024;
const NODE_FLOOR = [22, 19, 0] as const;

const reasoningSchema = v.picklist(["low", "medium", "high"]);
const boundedPath = v.pipe(v.string(), v.minLength(1), v.maxLength(4_096));
const profileId = v.pipe(
  v.string(),
  v.regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/),
  v.maxLength(128),
);
/**
 * The review session identity, checked by the one domain parser that owns its
 * syntax. A copy of the pattern silently rejected every real invocation once
 * the domain id gained its `__base-` segment, so the child never restates it.
 */
const sessionId = v.pipe(
  v.string(),
  v.maxLength(256),
  v.check(
    (value) => parseReviewSessionId(value)._tag === "ok",
    "Not a Patchdesk review session identifier",
  ),
);

export const analysisInvocationSchema = v.strictObject({
  profileId,
  sessionId,
  contextPath: boundedPath,
  reviewInputPath: boundedPath,
  patchPath: boundedPath,
  worktreePath: boundedPath,
  model: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
  reasoning: reasoningSchema,
  prompt: v.pipe(v.string(), v.minLength(1), v.maxLength(6 * 1024 * 1024)),
});

export const walkthroughResultSchema = walkthroughOutputSchema;

export const walkthroughInvocationSchema = v.strictObject({
  profileId,
  sessionId,
  contextPath: boundedPath,
  patchPath: boundedPath,
  model: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
  reasoning: reasoningSchema,
  prompt: v.pipe(v.string(), v.minLength(1), v.maxLength(4 * 1024 * 1024)),
});

export const briefResultSchema = briefOutputSchema;

export const briefInvocationSchema = v.strictObject({
  profileId,
  sessionId,
  patchPath: boundedPath,
  model: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
  reasoning: reasoningSchema,
  prompt: v.pipe(v.string(), v.minLength(1), v.maxLength(4 * 1024 * 1024)),
});

/** Production child input is path/identity/model metadata only; it never accepts model prompt text. */
export const productionAnalysisInvocationSchema = v.strictObject({
  profileId,
  sessionId,
  contextPath: boundedPath,
  reviewInputPath: boundedPath,
  patchPath: boundedPath,
  worktreePath: boundedPath,
  model: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
  reasoning: reasoningSchema,
});

/** Production child Walkthrough input likewise never accepts model prompt text. */
export const productionWalkthroughInvocationSchema = v.strictObject({
  profileId,
  sessionId,
  contextPath: boundedPath,
  patchPath: boundedPath,
  model: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
  reasoning: reasoningSchema,
});

/**
 * Production child Brief input likewise never accepts model prompt text: the
 * child builds the Brief prompt itself from the patch path alone.
 */
export const productionBriefInvocationSchema = v.strictObject({
  profileId,
  sessionId,
  patchPath: boundedPath,
  model: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
  reasoning: reasoningSchema,
});

export type AnalysisInvocation = v.InferOutput<typeof analysisInvocationSchema>;
export type WalkthroughInvocation = v.InferOutput<
  typeof walkthroughInvocationSchema
>;
export type BriefInvocation = v.InferOutput<typeof briefInvocationSchema>;
export type InspectorOperations = {
  readonly listChangedFiles: () => Promise<
    { readonly files: Array<string> } | { readonly denied: true }
  >;
  readonly searchFiles: (
    query: string,
  ) => Promise<{ readonly files: Array<string> } | { readonly denied: true }>;
  readonly readFileRange: (
    path: string,
    startLine: number,
    endLine: number,
  ) => Promise<{ readonly content: string } | { readonly denied: true }>;
  readonly gitShow: (
    revision: string,
  ) => Promise<{ readonly content: string } | { readonly denied: true }>;
};

/** The one value a submission records, already parsed by its own result schema. */
type SubmittedInsightResult =
  | v.InferOutput<typeof modelReviewResultSchema>
  | v.InferOutput<typeof walkthroughResultSchema>
  | v.InferOutput<typeof briefResultSchema>;

/** The one submission each invocation is allowed to make, and what it carried. */
type SubmissionState = {
  submitted: boolean;
  value?: SubmittedInsightResult;
};

type AgentExecutionState = {
  /** The one submitted result, or undefined while nothing has been submitted. */
  readonly submittedResult: () => SubmittedInsightResult | undefined;
};

/**
 * What one invocation's agent may reach. The child drives Pi's agent loop
 * directly and the loop mounts no tool of its own, so a sandbox, an MCP
 * connection, and a subagent are not merely undeclared here: no code path in
 * this runtime can create one.
 */
type AgentCapabilityReport = {
  readonly customTools: ReadonlyArray<string>;
  readonly usesSkill: boolean;
  readonly usesSandbox: false;
  readonly usesMcp: false;
  readonly usesSubagent: false;
};

/** Verifies the Node runtime requirement before a child builds an agent. */
export function assertSupportedNode(
  version: string = process.versions.node,
): void {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (match === null) throw new Error("runtime_unavailable");
  const current = match.slice(1).map(Number);
  const [major, minor, patch] = current;
  const [floorMajor, floorMinor, floorPatch] = NODE_FLOOR;
  if (
    major === undefined ||
    minor === undefined ||
    patch === undefined ||
    major < floorMajor ||
    (major === floorMajor && minor < floorMinor) ||
    (major === floorMajor && minor === floorMinor && patch < floorPatch)
  )
    throw new Error("runtime_unavailable");
}

/** The fixed trusted skill an Analysis system prompt carries verbatim. */
export type PatchdeskReviewSkill = {
  readonly name: string;
  readonly description: string;
  readonly instructions: string;
};

/** Reads the fixed trusted skill and rejects malformed or resource-bearing skill folders. */
export async function loadPatchdeskReviewSkill(
  skillPath: string,
): Promise<PatchdeskReviewSkill> {
  const raw = await readFile(skillPath, "utf8");
  const match =
    /^---\r?\nname:\s*([^\r\n]+)\r?\ndescription:\s*(?:"([^"\r\n]+)"|([^\r\n]+))\r?\n---\r?\n([\s\S]+)$/u.exec(
      raw,
    );
  if (match === null) throw new Error("runtime_unavailable");
  const [, name, quotedDescription, plainDescription, instructions] = match;
  const description = quotedDescription ?? plainDescription;
  if (
    name === undefined ||
    description === undefined ||
    instructions === undefined
  )
    throw new Error("runtime_unavailable");
  return { name: name.trim(), description, instructions };
}

/** The one result schema each agent submits through `submit_patchdesk_result`. */
type PatchdeskResultSchema =
  | typeof modelReviewResultSchema
  | typeof walkthroughResultSchema
  | typeof briefResultSchema;

/**
 * Projects one Valibot schema onto the JSON Schema Pi validates tool arguments
 * against. Exactly one constraint cannot be expressed and is dropped: the
 * top-level `v.check` in `src/services/walkthrough-operation.ts` capping a
 * Walkthrough's total section count across chapters. The tool's own
 * `v.safeParse` still enforces it before anything is recorded, so `ignore`
 * rather than `warn` -- `warn` printed that one known omission to stderr on
 * every walkthrough child run.
 */
function jsonSchemaFor(
  schema: PatchdeskResultSchema | v.GenericSchema,
): AgentTool["parameters"] {
  const projected: object = toJsonSchema(schema, { errorMode: "ignore" });
  // SAFETY: the agent loop validates tool arguments against plain JSON Schema
  // and only its declared TypeBox type is narrower than what it accepts, so
  // one projected JSON Schema object is exactly the value it validates with.
  return projected as AgentTool["parameters"];
}

function textContent(text: string): TextContent {
  return { type: "text", text };
}

function createResultTool(
  schema: PatchdeskResultSchema,
  state: SubmissionState,
): AgentTool {
  return {
    name: "submit_patchdesk_result",
    label: "Submit Patchdesk result",
    description:
      "Submit the one complete Patchdesk result after all needed inspection. This ends the operation.",
    parameters: jsonSchemaFor(schema),
    // Two submissions inside one assistant message must not race: sequential
    // execution is what makes the duplicate guard below deterministic.
    executionMode: "sequential",
    async execute(_toolCallId, args) {
      if (state.submitted) {
        return {
          content: [textContent("Result already recorded.")],
          details: undefined,
          terminate: true,
        };
      }
      const parsed = v.safeParse(schema, args);
      if (!parsed.success)
        throw new Error(
          "The submitted result does not match the Patchdesk result schema.",
        );
      state.submitted = true;
      state.value = parsed.output;
      return {
        content: [textContent("Result recorded.")],
        details: undefined,
        terminate: true,
      };
    },
  };
}

/** The one bounded value an inspector call hands back to the model. */
type InspectorOutcome =
  | { readonly files: Array<string> }
  | { readonly content: string }
  | { readonly denied: true };

const listChangedFilesInput = v.object({});
const searchFilesInput = v.object({
  query: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
});
const readFileRangeInput = v.object({
  path: v.pipe(v.string(), v.minLength(1)),
  startLine: v.pipe(v.number(), v.integer(), v.minValue(1)),
  endLine: v.pipe(v.number(), v.integer(), v.minValue(1)),
});
const gitShowInput = v.object({
  revision: v.pipe(v.string(), v.minLength(1)),
});

function inspectorTools(
  operations: InspectorOperations,
  state: SubmissionState,
): Array<AgentTool> {
  /** An inspector never ends a run of its own; it only follows a submission. */
  function inspectorResult(output: InspectorOutcome) {
    return {
      content: [textContent(JSON.stringify(output))],
      details: output,
      terminate: state.submitted,
    };
  }
  return [
    {
      name: "list_changed_files",
      label: "List changed files",
      description:
        "List the repository-relative files changed by this pull request.",
      parameters: jsonSchemaFor(listChangedFilesInput),
      async execute() {
        return inspectorResult(await operations.listChangedFiles());
      },
    },
    {
      name: "search_files",
      label: "Search changed files",
      description: "Search the changed files for a literal query.",
      parameters: jsonSchemaFor(searchFilesInput),
      async execute(_toolCallId, args) {
        const data = v.parse(searchFilesInput, args);
        return inspectorResult(await operations.searchFiles(data.query));
      },
    },
    {
      name: "read_file_range",
      label: "Read a file range",
      description:
        "Read an inclusive line range from one repository-relative file.",
      parameters: jsonSchemaFor(readFileRangeInput),
      async execute(_toolCallId, args) {
        const data = v.parse(readFileRangeInput, args);
        return inspectorResult(
          await operations.readFileRange(
            data.path,
            data.startLine,
            data.endLine,
          ),
        );
      },
    },
    {
      name: "git_show",
      label: "Show a Git revision",
      description:
        "Read the immutable prepared review head or an explicitly supplied full Git revision.",
      parameters: jsonSchemaFor(gitShowInput),
      async execute(_toolCallId, args) {
        const data = v.parse(gitShowInput, args);
        return inspectorResult(await operations.gitShow(data.revision));
      },
    },
  ];
}

/**
 * Everything one invocation needs to drive Pi's agent loop once: the system
 * prompt the child composed, the model specifier to resolve, the reasoning
 * level, and the only tools the model may see.
 */
export type InsightAgentSpec = {
  readonly systemPrompt: string;
  readonly model: string;
  readonly thinkingLevel: ThinkingLevel;
  readonly tools: ReadonlyArray<AgentTool>;
};

/** One invocation-scoped agent spec, with the state and capabilities it was built with. */
export type CreatedInsightAgent = {
  readonly spec: InsightAgentSpec;
  readonly state: AgentExecutionState;
  readonly capabilities: AgentCapabilityReport;
};

function executionState(state: SubmissionState): AgentExecutionState {
  return { submittedResult: () => state.value };
}

/**
 * Renders the trusted review skill into the Analysis system prompt. The child
 * has no skill-activation tool to offer the model, so the instructions the
 * skill file carries are part of the prompt from the first turn.
 */
function skillSection(skill: PatchdeskReviewSkill): string {
  return `# Patchdesk review skill: ${skill.name}\n\n${skill.description}\n\n${skill.instructions.trim()}`;
}

/** Creates an invocation-scoped Analysis agent with only four inspectors and result submission. */
export function createAnalysisAgent(
  input: AnalysisInvocation,
  operations: InspectorOperations,
  skill: PatchdeskReviewSkill,
): CreatedInsightAgent {
  const state: SubmissionState = { submitted: false };
  return {
    spec: {
      systemPrompt: `${input.prompt}\n\n${skillSection(skill)}\n\nFollow the Patchdesk review skill above. Use only the supplied inspection tools. Submit exactly one result with submit_patchdesk_result and do not provide an independent answer.`,
      model: input.model,
      thinkingLevel: input.reasoning,
      tools: [
        createResultTool(modelReviewResultSchema, state),
        ...inspectorTools(operations, state),
      ],
    },
    state: executionState(state),
    capabilities: {
      customTools: [
        "list_changed_files",
        "search_files",
        "read_file_range",
        "git_show",
        "submit_patchdesk_result",
      ],
      usesSkill: true,
      usesSandbox: false,
      usesMcp: false,
      usesSubagent: false,
    },
  };
}

/** Creates an invocation-scoped Walkthrough agent with only result submission. */
export function createWalkthroughAgent(
  input: WalkthroughInvocation,
): CreatedInsightAgent {
  const state: SubmissionState = { submitted: false };
  return {
    spec: {
      systemPrompt: `${input.prompt}\n\nSubmit exactly one result with submit_patchdesk_result and do not provide an independent answer.`,
      model: input.model,
      thinkingLevel: input.reasoning,
      tools: [createResultTool(walkthroughResultSchema, state)],
    },
    state: executionState(state),
    capabilities: {
      customTools: ["submit_patchdesk_result"],
      usesSkill: false,
      usesSandbox: false,
      usesMcp: false,
      usesSubagent: false,
    },
  };
}

/**
 * Creates an invocation-scoped Brief agent with only result submission. A Brief
 * cites the patch its prompt already carries, so it mounts no inspector: the
 * inspector can only see the changed-file snapshots the prompt is built from.
 */
export function createBriefAgent(input: BriefInvocation): CreatedInsightAgent {
  const state: SubmissionState = { submitted: false };
  return {
    spec: {
      systemPrompt: `${input.prompt}\n\nSubmit exactly one result with submit_patchdesk_result and do not provide an independent answer.`,
      model: input.model,
      thinkingLevel: input.reasoning,
      tools: [createResultTool(briefResultSchema, state)],
    },
    state: executionState(state),
    capabilities: {
      customTools: ["submit_patchdesk_result"],
      usesSkill: false,
      usesSandbox: false,
      usesMcp: false,
      usesSubagent: false,
    },
  };
}

export { modelReviewResultSchema };
