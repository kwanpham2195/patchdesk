import * as v from "valibot";
import { toJsonSchema } from "@valibot/to-json-schema";

import { insightOutputGuidance } from "../domain/insight-output-guidance";
import {
  INSIGHT_LANGUAGES,
  type InsightLanguage,
} from "../domain/insight-provider";
import { narrativeHunkManifest } from "../domain/narrative-walkthrough";
import { err, ok, type Result } from "../domain/result";
import {
  readBoundedArtifact,
  type BoundedArtifactReadError,
} from "./walkthrough-artifact-reader";

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
const MAX_GUIDED_SECTIONS = 12;
const MAX_GUIDED_HUNKS_PER_SECTION = 3;
const MAX_GUIDED_HUNKS = MAX_GUIDED_SECTIONS * MAX_GUIDED_HUNKS_PER_SECTION;
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
  language: v.picklist(INSIGHT_LANGUAGES),
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

/** Codex constrains its final JSON with the same field schema; Patchdesk still checks the aggregate section rule after the turn. */
export const walkthroughCodexOutputSchema = toJsonSchema(
  walkthroughOutputSchema,
  {
    errorMode: "ignore",
    // Codex requires a type on literal fields; Valibot emits only { const: 2 }.
    overrideSchema: ({ valibotSchema, jsonSchema }) =>
      valibotSchema.type === "literal" && jsonSchema.const === 2
        ? { type: "integer", enum: [2] }
        : undefined,
  },
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

/** Summarize at most two schema limit violations without logging model text or repository paths. */
export function walkthroughOutputLimitDiagnostic(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- the schema below parses the provider result before issue fields are inspected.
  input: unknown,
): string | undefined {
  const parsed = v.safeParse(walkthroughOutputSchema, input);
  if (parsed.success) return undefined;
  const details: Array<string> = [];
  for (const issue of parsed.issues) {
    if (issue.type !== "max_length") continue;
    const path = issue.path?.map((segment) => segment.key);
    if (path === undefined) continue;
    let label: string | undefined;
    let limit: number | undefined;
    if (path.length === 1) {
      if (path[0] === "title") [label, limit] = ["title", MAX_TITLE_LENGTH];
      if (path[0] === "focus") [label, limit] = ["focus", MAX_FOCUS_LENGTH];
      if (path[0] === "chapters") [label, limit] = ["chapters", MAX_CHAPTERS];
    } else if (path[0] === "chapters") {
      const chapter = boundedIndex(path[1], MAX_CHAPTERS);
      if (chapter === undefined) continue;
      const chapterPath = `chapters[${chapter}]`;
      if (path.length === 3 && path[2] === "title")
        [label, limit] = [`${chapterPath}.title`, MAX_CHAPTER_TITLE_LENGTH];
      if (path.length === 3 && path[2] === "sections")
        [label, limit] = [`${chapterPath}.sections`, MAX_SECTIONS];
      if (path[2] === "sections" && path.length >= 5) {
        const section = boundedIndex(path[3], MAX_SECTIONS);
        if (section === undefined) continue;
        const sectionPath = `${chapterPath}.sections[${section}]`;
        if (path.length === 5) {
          if (path[4] === "title")
            [label, limit] = [`${sectionPath}.title`, MAX_SECTION_TITLE_LENGTH];
          if (path[4] === "prose")
            [label, limit] = [`${sectionPath}.prose`, MAX_PROSE_LENGTH];
          if (path[4] === "hunkIds")
            [label, limit] = [`${sectionPath}.hunkIds`, MAX_HUNKS_PER_SECTION];
        } else if (path.length === 6 && path[4] === "hunkIds") {
          const alias = boundedIndex(path[5], MAX_HUNKS_PER_SECTION);
          if (alias !== undefined)
            [label, limit] = [
              `${sectionPath}.hunkIds[${alias}]`,
              MAX_HUNK_ALIAS_LENGTH,
            ];
        }
      }
    }
    if (label === undefined || limit === undefined) continue;
    const measured = v.safeParse(
      v.union([v.string(), v.array(v.unknown())]),
      issue.input,
    );
    if (!measured.success) continue;
    details.push(`${label}_${measured.output.length}_gt_${limit}`);
    if (details.length === 2) break;
  }
  return details.length === 0 ? undefined : details.join(",");
}

function boundedIndex(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Valibot issue paths are untrusted; the parser below proves a bounded numeric index before it is rendered.
  value: unknown,
  max: number,
): number | undefined {
  const index = v.safeParse(
    v.pipe(v.number(), v.safeInteger(), v.minValue(0), v.maxValue(max - 1)),
    value,
  );
  return index.success ? index.output : undefined;
}

/** Why a walkthrough prompt could not be composed from its artifacts. */
export type WalkthroughPromptFailure =
  | {
      readonly reason: "artifact_too_large";
      readonly artifact: "context" | "patch";
    }
  | {
      readonly reason: "artifact_unreadable";
      readonly artifact: "context" | "patch";
    }
  | { readonly reason: "patch_not_indexable" };

/**
 * Reads fixed bounded artifacts and composes the only model-visible walkthrough
 * prompt.
 *
 * Returns `artifact_too_large` or `artifact_unreadable` naming the artifact the
 * bounded reader refused, and `patch_not_indexable` when the patch carries no
 * hunk the manifest can alias.
 */
export async function prepareWalkthroughPrompt(input: {
  readonly contextPath: string;
  readonly patchPath: string;
  readonly language: InsightLanguage;
}): Promise<Result<string, WalkthroughPromptFailure>> {
  const [contextRead, patchRead] = await Promise.all([
    readBoundedArtifact(input.contextPath, MAX_WALKTHROUGH_CONTEXT_BYTES),
    readBoundedArtifact(input.patchPath, MAX_WALKTHROUGH_ARTIFACT_BYTES),
  ]);
  if (contextRead._tag === "err")
    return err(artifactFailure("context", contextRead.error));
  if (patchRead._tag === "err")
    return err(artifactFailure("patch", patchRead.error));
  const context = contextRead.value;
  const patch = patchRead.value;
  const manifest = narrativeHunkManifest(patch);
  if (manifest._tag === "err") return err({ reason: "patch_not_indexable" });
  const changedFileCount = new Set(manifest.value.map((hunk) => hunk.path))
    .size;
  const largePatchGuidance =
    manifest.value.length >= 100 && changedFileCount >= 20
      ? `This patch spans ${changedFileCount} files and ${manifest.value.length} hunks. Build a substantive guided path: aim for 3–6 chapters and 8–12 sections across distinct behavior areas, citing 18–36 representative hunks in total. Start with the main behavior and interface changes; include relevant consequences, tests, and deployment. Do not focus on a single file or area while other major changes go unexplained. Avoid duplicate sections for repeated moves or other repetitive edits.`
      : "For a smaller patch, keep the path proportional to the distinct changes.";
  return ok(
    [
      "Generate a read-only walkthrough for the supplied immutable patch.",
      insightOutputGuidance("walkthrough", input.language),
      "The persistent reader shows the chapters in order on a rail and their sections on one continuous reading surface.",
      "Write the top-level focus as a summary of what the patch does; keep hunk aliases and paths out of it.",
      `Select representative hunks that establish the main behavior changes. Use at most ${MAX_GUIDED_SECTIONS} sections, cite at most ${MAX_GUIDED_HUNKS} distinct hunks across the whole walkthrough, and cite at most ${MAX_GUIDED_HUNKS_PER_SECTION} hunks per section. Do not list extra hunks simply to claim coverage.`,
      largePatchGuidance,
      "Hunks you do not cite are not explained in the reading path. Patchdesk counts all uncited hunks and offers the full Diff, including changes that may matter. Do not describe them as mechanical or unimportant.",
      "Each chapter follows a coherent behavior; a chapter for a single isolated hunk is the exception.",
      "Set citationVersion to 2. In each section's prose, state only the behavior change and name the exact repo-relative path of every cited hunk. Use only the supplied alias manifest; never invent aliases, paths, lines, or actions.",
      `Use at most ${MAX_CHAPTERS} chapters and at most ${MAX_TOTAL_SECTIONS} sections in total. Keep the title within ${MAX_TITLE_LENGTH} characters, the focus within ${MAX_FOCUS_LENGTH}, each chapter title within ${MAX_CHAPTER_TITLE_LENGTH}, each section title within ${MAX_SECTION_TITLE_LENGTH}, and each section's prose within ${MAX_PROSE_LENGTH}.`,
      "HUNK ALIAS MANIFEST:",
      manifest.value
        .map((hunk) => `${hunk.id} | ${hunk.path} | ${hunk.header}`)
        .join("\n"),
      "CONTEXT ARTIFACT:",
      context,
      "PATCH ARTIFACT:",
      patch,
    ].join("\n\n"),
  );
}

function artifactFailure(
  artifact: "context" | "patch",
  error: BoundedArtifactReadError,
): WalkthroughPromptFailure {
  return error.reason === "input_too_large"
    ? { reason: "artifact_too_large", artifact }
    : { reason: "artifact_unreadable", artifact };
}
