import { readFile } from "node:fs/promises";

import {
  defineSkill,
  defineTool,
  useDataWriter,
  useModel,
  useSkill,
  useTool,
  type Agent,
} from "@flue/runtime";
import * as v from "valibot";

import { modelReviewResultSchema } from "../../../src/domain/review-result";
import { walkthroughOutputSchema } from "../../../src/services/walkthrough-operation";

export const MAX_RUNTIME_STDIN_BYTES = 2 * 1024 * 1024;
export const MAX_RUNTIME_STDOUT_BYTES = 2 * 1024 * 1024;
export const NODE_FLOOR = [22, 19, 0] as const;

const reasoningSchema = v.picklist(["low", "medium", "high"]);
const boundedPath = v.pipe(v.string(), v.minLength(1), v.maxLength(4_096));
const profileId = v.pipe(
  v.string(),
  v.regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/),
  v.maxLength(128),
);
const sessionId = v.pipe(
  v.string(),
  v.regex(
    /^[a-zA-Z0-9.-]+__[a-zA-Z0-9._-]+__[a-zA-Z0-9._-]+__pr-[1-9]\d*__sha-[a-f0-9]{8}__[a-f0-9]{12}$/,
  ),
  v.maxLength(256),
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

export type AnalysisInvocation = v.InferOutput<typeof analysisInvocationSchema>;
export type WalkthroughInvocation = v.InferOutput<
  typeof walkthroughInvocationSchema
>;
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

type AgentExecutionState = {
  readonly duplicateSubmissionAttempted: () => boolean;
};

type AgentCapabilityReport = {
  readonly customTools: ReadonlyArray<string>;
  readonly usesSkill: boolean;
  readonly usesSandbox: false;
  readonly usesMcp: false;
  readonly usesSubagent: false;
};

/** Verifies the Node runtime requirement before a child configures Flue. */
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

/** Reads the fixed trusted skill and rejects malformed or resource-bearing skill folders. */
export async function loadPatchdeskReviewSkill(
  skillPath: string,
): Promise<ReturnType<typeof defineSkill>> {
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
  return defineSkill({ name: name.trim(), description, instructions });
}

/** The one result schema each agent submits through `submit_patchdesk_result`. */
type PatchdeskResultSchema =
  | typeof modelReviewResultSchema
  | typeof walkthroughResultSchema;

function createResultTool<TSchema extends PatchdeskResultSchema>(
  schema: TSchema,
  write: (value: v.InferOutput<TSchema>) => void,
  state: { submitted: boolean; duplicate: boolean },
) {
  return defineTool({
    name: "submit_patchdesk_result",
    description:
      "Submit the one complete Patchdesk result after all needed inspection. This ends the operation.",
    input: schema,
    async run({ data }) {
      if (state.submitted) {
        state.duplicate = true;
        return { output: "Result already recorded.", terminate: true };
      }
      state.submitted = true;
      write(data);
      return { output: "Result recorded.", terminate: true };
    },
  });
}

function inspectorTools(
  operations: InspectorOperations,
  state: { submitted: boolean },
) {
  return [
    defineTool({
      name: "list_changed_files",
      description:
        "List the repository-relative files changed by this pull request.",
      input: v.object({}),
      output: v.union([
        v.object({ files: v.array(v.string()) }),
        v.object({ denied: v.literal(true) }),
      ]),
      async run() {
        const output = await operations.listChangedFiles();
        return { output, terminate: state.submitted };
      },
    }),
    defineTool({
      name: "search_files",
      description: "Search the changed files for a literal query.",
      input: v.object({
        query: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
      }),
      output: v.union([
        v.object({ files: v.array(v.string()) }),
        v.object({ denied: v.literal(true) }),
      ]),
      async run({ data }) {
        const output = await operations.searchFiles(data.query);
        return { output, terminate: state.submitted };
      },
    }),
    defineTool({
      name: "read_file_range",
      description:
        "Read an inclusive line range from one repository-relative file.",
      input: v.object({
        path: v.pipe(v.string(), v.minLength(1)),
        startLine: v.pipe(v.number(), v.integer(), v.minValue(1)),
        endLine: v.pipe(v.number(), v.integer(), v.minValue(1)),
      }),
      output: v.union([
        v.object({ content: v.string() }),
        v.object({ denied: v.literal(true) }),
      ]),
      async run({ data }) {
        const output = await operations.readFileRange(
          data.path,
          data.startLine,
          data.endLine,
        );
        return { output, terminate: state.submitted };
      },
    }),
    defineTool({
      name: "git_show",
      description:
        "Read the immutable prepared review head or an explicitly supplied full Git revision.",
      input: v.object({ revision: v.pipe(v.string(), v.minLength(1)) }),
      output: v.union([
        v.object({ content: v.string() }),
        v.object({ denied: v.literal(true) }),
      ]),
      async run({ data }) {
        const output = await operations.gitShow(data.revision);
        return { output, terminate: state.submitted };
      },
    }),
  ];
}

/** One invocation-scoped agent, with the state and capabilities it was built with. */
export type CreatedInsightAgent = {
  readonly agent: Agent;
  readonly state: AgentExecutionState;
  readonly capabilities: AgentCapabilityReport;
};

/** Creates an invocation-scoped Analysis agent with only four inspectors and result submission. */
export function createAnalysisAgent(
  input: AnalysisInvocation,
  operations: InspectorOperations,
  skill: ReturnType<typeof defineSkill>,
): CreatedInsightAgent {
  const state = { submitted: false, duplicate: false };
  function PatchdeskAnalysisAgent() {
    useModel(input.model, { thinkingLevel: input.reasoning });
    const write = useDataWriter("patchdeskResult", {
      schema: modelReviewResultSchema,
    });
    useSkill(skill);
    useTool(createResultTool(modelReviewResultSchema, write, state));
    for (const tool of inspectorTools(operations, state)) useTool(tool);
    return `${input.prompt}\n\nActivate the Patchdesk review skill. Use only the supplied inspection tools. Submit exactly one result with submit_patchdesk_result and do not provide an independent answer.`;
  }
  return {
    agent: PatchdeskAnalysisAgent,
    state: { duplicateSubmissionAttempted: () => state.duplicate },
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
  const state = { submitted: false, duplicate: false };
  function PatchdeskWalkthroughAgent() {
    useModel(input.model, { thinkingLevel: input.reasoning });
    const write = useDataWriter("patchdeskResult", {
      schema: walkthroughResultSchema,
    });
    useTool(createResultTool(walkthroughResultSchema, write, state));
    return `${input.prompt}\n\nSubmit exactly one result with submit_patchdesk_result and do not provide an independent answer.`;
  }
  return {
    agent: PatchdeskWalkthroughAgent,
    state: { duplicateSubmissionAttempted: () => state.duplicate },
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
