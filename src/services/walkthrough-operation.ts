import * as v from "valibot";

import { insightOutputGuidance } from "../domain/insight-output-guidance";
import { narrativeHunkManifest } from "../domain/narrative-walkthrough";
import { err, ok, type Result } from "../domain/result";
import { readBoundedArtifact } from "./walkthrough-artifact-reader";

const MAX_WALKTHROUGH_ARTIFACT_BYTES = 2 * 1024 * 1024;
const MAX_WALKTHROUGH_CONTEXT_BYTES = 512 * 1024;
const MAX_TITLE_LENGTH = 200;
const MAX_FOCUS_LENGTH = 320;
const MAX_CHAPTERS = 12;
const MAX_SECTIONS = 32;
const MAX_SECTION_TITLE_LENGTH = 160;
const MAX_CHAPTER_TITLE_LENGTH = 80;
const MAX_PROSE_LENGTH = 320;
const MAX_HUNKS_PER_SECTION = 32;
const MAX_HUNK_ALIAS_LENGTH = 16;
const MAX_TOTAL_SECTIONS = 32;
const HUNK_ALIAS = /^h[1-9]\d*$/;

const boundedIdentifier = (maxLength: number) =>
  v.pipe(v.string(), v.minLength(1), v.maxLength(maxLength));
const reasoningSchema = v.picklist(["low", "medium", "high"]);

/** Strict app-owned input for a finite walkthrough operation. */
const walkthroughInputSchema = v.strictObject({
  profileId: boundedIdentifier(128),
  sessionId: boundedIdentifier(256),
  contextPath: boundedIdentifier(4_096),
  patchPath: boundedIdentifier(4_096),
  model: boundedIdentifier(200),
  reasoning: reasoningSchema,
});

const walkthroughSectionSchema = v.strictObject({
  title: v.pipe(
    v.string(),
    v.minLength(1),
    v.maxLength(MAX_SECTION_TITLE_LENGTH),
  ),
  prose: v.pipe(v.string(), v.minLength(1), v.maxLength(MAX_PROSE_LENGTH)),
  hunkIds: v.pipe(
    v.array(
      v.pipe(
        v.string(),
        v.maxLength(MAX_HUNK_ALIAS_LENGTH),
        v.regex(HUNK_ALIAS),
      ),
    ),
    v.maxLength(MAX_HUNKS_PER_SECTION),
  ),
});
const walkthroughChapterSchema = v.strictObject({
  title: v.pipe(
    v.string(),
    v.minLength(1),
    v.maxLength(MAX_CHAPTER_TITLE_LENGTH),
  ),
  sections: v.pipe(
    v.array(walkthroughSectionSchema),
    v.maxLength(MAX_SECTIONS),
  ),
});

/** Raw structured output accepted before Patchdesk snapshot normalization. */
export const walkthroughOutputSchema = v.pipe(
  v.strictObject({
    citationVersion: v.literal(2),
    title: v.pipe(v.string(), v.minLength(1), v.maxLength(MAX_TITLE_LENGTH)),
    focus: v.pipe(v.string(), v.minLength(1), v.maxLength(MAX_FOCUS_LENGTH)),
    chapters: v.pipe(
      v.array(walkthroughChapterSchema),
      v.maxLength(MAX_CHAPTERS),
    ),
  }),
  v.check(
    (output) =>
      output.chapters.reduce(
        (count, chapter) => count + chapter.sections.length,
        0,
      ) <= MAX_TOTAL_SECTIONS,
    "Walkthrough output exceeds the aggregate section limit",
  ),
);

export type WalkthroughInput = v.InferOutput<typeof walkthroughInputSchema>;
export type WalkthroughOutput = v.InferOutput<typeof walkthroughOutputSchema>;
export type InvalidWalkthroughOutput = {
  readonly _tag: "InvalidWalkthroughOutput";
};

export function parseWalkthroughOutput(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- this is the walkthrough output's own I/O boundary; the very next statement runs `safeParse(walkthroughOutputSchema, input)` against it before anything else touches it.
  input: unknown,
): Result<WalkthroughOutput, InvalidWalkthroughOutput> {
  const parsed = v.safeParse(walkthroughOutputSchema, input);
  return parsed.success
    ? ok(parsed.output)
    : err({ _tag: "InvalidWalkthroughOutput" });
}

/** Reads fixed bounded artifacts and composes the only model-visible walkthrough prompt. */
export async function prepareWalkthroughPrompt(input: {
  readonly contextPath: string;
  readonly patchPath: string;
}): Promise<string> {
  const [context, patch] = await Promise.all([
    readRequiredArtifact(input.contextPath, MAX_WALKTHROUGH_CONTEXT_BYTES),
    readRequiredArtifact(input.patchPath, MAX_WALKTHROUGH_ARTIFACT_BYTES),
  ]);
  const manifest = narrativeHunkManifest(patch);
  if (manifest._tag === "err")
    throw new Error("Walkthrough patch could not be indexed");
  const targetChapters = Math.min(
    MAX_CHAPTERS,
    Math.max(
      1,
      Math.ceil(Math.max(1, (patch.match(/^@@ /gm) ?? []).length) / 3),
    ),
  );
  return [
    "Generate a read-only walkthrough for the supplied immutable patch.",
    insightOutputGuidance("walkthrough"),
    "The persistent reader shows the chapters in order on a rail and their sections on one continuous reading surface.",
    "Write the top-level focus as one or two concise sentences summarizing what the patch does; keep hunk aliases and paths out of it.",
    "Explain behavior before consequences and validation; use aliases exactly, and route only mechanical or low-signal changes to Support.",
    `Create at most ${targetChapters} chapters. Each chapter cites the coherent cluster of hunks that establishes its behavior; an isolated one-hunk change is the only exception.`,
    "Set citationVersion to 2. Write each section's prose as one concise sentence, or at most two very short sentences: state only the behavior change and name the exact repo-relative path of every cited hunk. Use only the supplied alias manifest; never invent aliases, paths, lines, or actions.",
    `Use at most ${MAX_CHAPTERS} chapters and at most ${MAX_TOTAL_SECTIONS} sections in total. Keep the title within ${MAX_TITLE_LENGTH} characters, the focus within ${MAX_FOCUS_LENGTH}, each chapter title within ${MAX_CHAPTER_TITLE_LENGTH}, each section title within ${MAX_SECTION_TITLE_LENGTH}, and each section's prose within ${MAX_PROSE_LENGTH}.`,
    "HUNK ALIAS MANIFEST:",
    manifest.value
      .map((hunk) => `${hunk.id} | ${hunk.path} | ${hunk.header}`)
      .join("\n"),
    "CONTEXT ARTIFACT:",
    context,
    "PATCH ARTIFACT:",
    patch,
  ].join("\n\n");
}

async function readRequiredArtifact(
  path: string,
  maxBytes: number,
): Promise<string> {
  const result = await readBoundedArtifact(path, maxBytes);
  if (result._tag === "ok") return result.value;
  if (result.error.reason === "input_too_large")
    throw new Error("Walkthrough artifact exceeds the bounded input size");
  throw new Error("Walkthrough artifact could not be read");
}
