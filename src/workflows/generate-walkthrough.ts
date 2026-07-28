import { defineAgent, defineWorkflow } from "@flue/runtime";
import * as v from "valibot";

import type { FlueHarness } from "../flue-runtime-types";
import { err, ok, type Result } from "../domain/result";
import { readBoundedArtifact } from "./walkthrough-artifact-reader";

const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024;
const MAX_CONTEXT_BYTES = 512 * 1024;
const MAX_TITLE_LENGTH = 200;
const MAX_FOCUS_LENGTH = 2_000;
const MAX_CHAPTERS = 12;
const MAX_SECTIONS = 32;
const MAX_SECTION_TITLE_LENGTH = 160;
const MAX_CHAPTER_TITLE_LENGTH = 80;
const MAX_PROSE_LENGTH = 4_000;
const MAX_HUNKS_PER_SECTION = 32;
const MAX_HUNK_ALIAS_LENGTH = 16;
const MAX_TOTAL_SECTIONS = 32;
const HUNK_ALIAS = /^h[1-9]\d*$/;

const boundedIdentifier = (maxLength: number) => v.pipe(v.string(), v.minLength(1), v.maxLength(maxLength));
const reasoningSchema = v.picklist(["low", "medium", "high"]);

/** Strict main-process input for the finite walkthrough workflow. */
export const walkthroughInputSchema = v.strictObject({
  profileId: boundedIdentifier(128),
  sessionId: boundedIdentifier(256),
  contextPath: boundedIdentifier(4_096),
  patchPath: boundedIdentifier(4_096),
  model: boundedIdentifier(200),
  reasoning: reasoningSchema,
});

const walkthroughSectionSchema = v.strictObject({
  title: v.pipe(v.string(), v.minLength(1), v.maxLength(MAX_SECTION_TITLE_LENGTH)),
  prose: v.pipe(v.string(), v.minLength(1), v.maxLength(MAX_PROSE_LENGTH)),
  hunkIds: v.pipe(
    v.array(v.pipe(v.string(), v.maxLength(MAX_HUNK_ALIAS_LENGTH), v.regex(HUNK_ALIAS))),
    v.maxLength(MAX_HUNKS_PER_SECTION),
  ),
});

const walkthroughChapterSchema = v.strictObject({
  title: v.pipe(v.string(), v.minLength(1), v.maxLength(MAX_CHAPTER_TITLE_LENGTH)),
  sections: v.pipe(v.array(walkthroughSectionSchema), v.maxLength(MAX_SECTIONS)),
});

/** Raw structured output accepted from Flue before snapshot normalization. */
export const walkthroughOutputSchema = v.pipe(
  v.strictObject({
    title: v.pipe(v.string(), v.minLength(1), v.maxLength(MAX_TITLE_LENGTH)),
    focus: v.pipe(v.string(), v.minLength(1), v.maxLength(MAX_FOCUS_LENGTH)),
    chapters: v.pipe(v.array(walkthroughChapterSchema), v.maxLength(MAX_CHAPTERS)),
  }),
  v.check(
    (output) => totalSectionCount(output) <= MAX_TOTAL_SECTIONS,
    "Walkthrough output exceeds the aggregate section limit",
  ),
);

export type WalkthroughInput = v.InferOutput<typeof walkthroughInputSchema>;
export type WalkthroughOutput = v.InferOutput<typeof walkthroughOutputSchema>;
export type InvalidWalkthroughOutput = { readonly _tag: "InvalidWalkthroughOutput" };

/** Parses only the bounded, strict JSON shape emitted by the workflow. */
export function parseWalkthroughOutput(
  input: unknown,
): Result<WalkthroughOutput, InvalidWalkthroughOutput> {
  const parsed = v.safeParse(walkthroughOutputSchema, input);
  if (!parsed.success) return err({ _tag: "InvalidWalkthroughOutput" });

  return ok(parsed.output);
}

const walkthroughAgent = defineAgent(() => ({
  instructions:
    "Create a concise semantic explanation of one immutable pull-request patch. Return only the required structured result. Explain behavior before consequences and validation, use hunk aliases exactly as supplied, and place mechanical or low-signal changes in Support by leaving them out of primary sections. Never invent a path, line number, hunk alias, or action.",
  model: "opencode-go/deepseek-v4-flash",
  skills: [],
}));

/**
 * A finite, read-only Flue workflow. It reads only the two main-process-owned
 * artifacts supplied in its validated input and returns bounded structured data.
 */
export async function runWalkthroughWorkflow({
  harness,
  input,
}: {
  readonly harness: FlueHarness;
  readonly input: WalkthroughInput;
}): Promise<WalkthroughOutput> {
  const [context, patch] = await Promise.all([
    readWorkflowArtifact(input.contextPath, MAX_CONTEXT_BYTES),
    readWorkflowArtifact(input.patchPath, MAX_ARTIFACT_BYTES),
  ]);
  const response = await harness.session().then((session) =>
    session.prompt<WalkthroughOutput>(composeWalkthroughPrompt({ input, context, patch }), {
      result: walkthroughOutputSchema,
      tools: [],
      model: input.model,
      thinkingLevel: input.reasoning,
    }),
  );
  return response.data;
}

export default defineWorkflow({
  agent: walkthroughAgent,
  input: walkthroughInputSchema,
  output: walkthroughOutputSchema,
  run: runWalkthroughWorkflow,
});

async function readWorkflowArtifact(path: string, maxBytes: number): Promise<string> {
  const result = await readBoundedArtifact(path, maxBytes);
  if (result._tag === "ok") return result.value;
  if (result.error.reason === "input_too_large") {
    throw new Error("Walkthrough artifact exceeds the bounded input size");
  }
  throw new Error("Walkthrough artifact could not be read");
}

function totalSectionCount(output: {
  readonly chapters: ReadonlyArray<{ readonly sections: ReadonlyArray<unknown> }>;
}): number {
  return output.chapters.reduce((count, chapter) => count + chapter.sections.length, 0);
}

function composeWalkthroughPrompt(input: {
  readonly input: WalkthroughInput;
  readonly context: string;
  readonly patch: string;
}): string {
  const hunkCount = countHunks(input.patch);
  const targetSections = Math.min(12, Math.max(1, Math.ceil(hunkCount / 3)));
  return [
    "Generate a read-only walkthrough for the supplied immutable patch.",
    "The persistent reader uses an ordered chapter rail and continuous reading surface; do not return a linear picker or wizard state.",
    "Explain behavior before consequences and validation; use aliases exactly, and route mechanical or low-signal changes to Support.",
    `Create at most ${targetSections} primary sections, then leave every mechanical or low-signal hunk unreferenced so Patchdesk can place it in Support.`,
    "Use request-local hunk aliases h1, h2, h3, ... in parsed patch order. Never invent aliases or paths.",
    `Profile ${input.input.profileId} and session ${input.input.sessionId} are provenance only; do not repeat them in prose.`,
    "CONTEXT ARTIFACT:",
    input.context,
    "PATCH ARTIFACT:",
    input.patch,
  ].join("\n\n");
}

function countHunks(patch: string): number {
  return Math.max(1, (patch.match(/^@@ /gm) ?? []).length);
}
