import * as v from "valibot";

import {
  parseContentHash,
  parseRepoRelativePath,
  type ContentHash,
  type RepoRelativePath,
} from "./ids";
import { err, ok, type Result } from "./result";

/**
 * The spec a local Review's change is checked against (#467): Markdown the
 * maintainer entered, or a spec file read from the reviewed head commit.
 * Only Analysis reads it; Brief and Walkthrough do not.
 */
export type ChangeIntent =
  | { readonly kind: "text"; readonly markdown: string }
  | { readonly kind: "file"; readonly path: RepoRelativePath };

/** The bound on entered text and on a spec file's bytes, in UTF-8 bytes. */
export const MAX_CHANGE_INTENT_BYTES = 65_536;

export type InvalidChangeIntent = { readonly _tag: "InvalidChangeIntent" };

/** The wire and stored form of a Change intent; `parseChangeIntent` applies the text and path rules. */
export const changeIntentSchema = v.variant("kind", [
  v.strictObject({ kind: v.literal("text"), markdown: v.string() }),
  v.strictObject({ kind: v.literal("file"), path: v.string() }),
]);

/** Text must hold more than whitespace and fit the byte bound; a path must stay inside the repository and name no `.` segment. */
export function parseChangeIntent(
  raw: v.InferOutput<typeof changeIntentSchema>,
): Result<ChangeIntent, InvalidChangeIntent> {
  if (raw.kind === "text") {
    return raw.markdown.trim().length === 0 ||
      new TextEncoder().encode(raw.markdown).length > MAX_CHANGE_INTENT_BYTES
      ? err({ _tag: "InvalidChangeIntent" })
      : ok({ kind: "text", markdown: raw.markdown });
  }
  const path = parseRepoRelativePath(raw.path);
  return path._tag === "ok" && !raw.path.split("/").includes(".")
    ? ok({ kind: "file", path: path.value })
    : err({ _tag: "InvalidChangeIntent" });
}

export function sameChangeIntent(
  a: ChangeIntent | undefined,
  b: ChangeIntent | undefined,
): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.kind === "text"
    ? b.kind === "text" && a.markdown === b.markdown
    : b.kind === "file" && a.path === b.path;
}

/** A Change intent with the Markdown an Analysis run reads for it, and that Markdown's sha256. */
export type ResolvedChangeIntent = {
  readonly intent: ChangeIntent;
  readonly markdown: string;
  readonly sha256: ContentHash;
};

/** The section `review-input.md` ends with when the Review has a Change intent; its heading starts a line nothing before it does. */
export function renderChangeIntentSection(
  resolved: ResolvedChangeIntent,
): string {
  const source =
    resolved.intent.kind === "text"
      ? "text entered by the maintainer"
      : `spec file \`${resolved.intent.path}\` at the reviewed revision`;
  return [
    "## Change intent",
    "",
    `Source: ${source}`,
    "",
    "BEGIN CHANGE INTENT",
    resolved.markdown.trimEnd(),
    "END CHANGE INTENT",
    "",
  ].join("\n");
}

/** What an Analysis result records about the Change intent it ran against: the source and the sha256 of the resolved Markdown. */
export type ChangeIntentProvenance =
  | { readonly kind: "text"; readonly sha256: ContentHash }
  | {
      readonly kind: "file";
      readonly path: RepoRelativePath;
      readonly sha256: ContentHash;
    };

/** What an Analysis run records about the Change intent it reads. */
export function changeIntentProvenance(
  resolved: ResolvedChangeIntent,
): ChangeIntentProvenance {
  return resolved.intent.kind === "text"
    ? { kind: "text", sha256: resolved.sha256 }
    : { kind: "file", path: resolved.intent.path, sha256: resolved.sha256 };
}

export const changeIntentProvenanceSchema = v.variant("kind", [
  v.strictObject({ kind: v.literal("text"), sha256: v.string() }),
  v.strictObject({
    kind: v.literal("file"),
    path: v.string(),
    sha256: v.string(),
  }),
]);

export function parseChangeIntentProvenance(
  raw: v.InferOutput<typeof changeIntentProvenanceSchema>,
): Result<ChangeIntentProvenance, InvalidChangeIntent> {
  const sha256 = parseContentHash(raw.sha256);
  if (sha256._tag === "err") return err({ _tag: "InvalidChangeIntent" });
  if (raw.kind === "text") return ok({ kind: "text", sha256: sha256.value });
  const path = parseRepoRelativePath(raw.path);
  return path._tag === "ok"
    ? ok({ kind: "file", path: path.value, sha256: sha256.value })
    : err({ _tag: "InvalidChangeIntent" });
}

/**
 * The Review's current Change intent setting as an Analysis result is
 * compared with it: text by the sha256 of its Markdown, a spec file by path.
 * Plain strings, so the renderer compares what it parsed off the wire.
 */
export type ChangeIntentSetting =
  | { readonly kind: "text"; readonly sha256: string }
  | { readonly kind: "file"; readonly path: string };

/** A local Review's Change intent as the workbench shows it, with the setting its Analysis is compared against. */
export type ChangeIntentView = {
  readonly intent: ChangeIntent;
  readonly setting: ChangeIntentSetting;
};

export const changeIntentViewSchema = v.strictObject({
  intent: changeIntentSchema,
  setting: v.variant("kind", [
    v.strictObject({ kind: v.literal("text"), sha256: v.string() }),
    v.strictObject({ kind: v.literal("file"), path: v.string() }),
  ]),
});

/**
 * True when an Analysis ran against the Review's current Change intent
 * setting, or both have none. A spec file counts as the same setting by path
 * alone, because its bytes belong to the reviewed revision, which the result's
 * own revision already binds.
 */
export function analysisRanAgainstChangeIntent(
  ran: (ChangeIntentSetting & { readonly sha256: string }) | undefined,
  current: ChangeIntentSetting | undefined,
): boolean {
  if (ran === undefined || current === undefined)
    return ran === undefined && current === undefined;
  if (ran.kind === "text")
    return current.kind === "text" && current.sha256 === ran.sha256;
  return current.kind === "file" && current.path === ran.path;
}
