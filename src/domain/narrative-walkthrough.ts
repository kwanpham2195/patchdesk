import * as v from "valibot";

import { definedProps } from "./defined-props";
import {
  parseContentHash,
  parseGitSha,
  parseReviewSessionId,
  parseWorkspaceProfileId,
  type ContentHash,
  type GitSha,
  type RepoRelativePath,
  type ReviewSessionId,
  type WorkspaceProfileId,
} from "./ids";
import { err, ok, type Result } from "./result";
import {
  parseNarrativePatch,
  type NarrativePatchHunk,
} from "./narrative-patch";

/** The immutable identity that binds a walkthrough to one stored patch. */
export type NarrativeSnapshot = {
  readonly profileId: WorkspaceProfileId;
  readonly sessionId: ReviewSessionId;
  readonly headSha: GitSha;
  readonly patchHash: ContentHash;
};

/** A bounded hunk projection safe for renderer consumption. */
export type NarrativeHunk = {
  readonly id: string;
  readonly path: RepoRelativePath;
  readonly header: string;
  readonly raw: string;
  /** The original file header, retained so renderers can reparse source hunks safely. */
  readonly filePrefix?: string;
  readonly oldStart: number;
  readonly oldLines: number;
  readonly newStart: number;
  readonly newLines: number;
};

/** A semantic reading section and the exact hunks that support it. */
type NarrativeSection = {
  readonly id: string;
  readonly title: string;
  readonly prose: string;
  readonly hunkIds: ReadonlyArray<string>;
  readonly hunks: ReadonlyArray<NarrativeHunk>;
};

/** An ordered chapter in the persistent walkthrough rail. */
type NarrativeChapter = {
  readonly id: string;
  readonly title: string;
  readonly sections: ReadonlyArray<NarrativeSection>;
};

/** The derived Support group containing every hunk outside the primary path. */
type NarrativeSupport = {
  readonly id: "support";
  readonly title: "Support";
  readonly hunkIds: ReadonlyArray<string>;
  readonly hunks: ReadonlyArray<NarrativeHunk>;
};

/** A normalized, snapshot-bound walkthrough ready for renderer projection. */
type NarrativeCitationStatus = "verified" | "partially_verified" | "unverified";

export type NarrativeWalkthrough = {
  readonly snapshot: NarrativeSnapshot;
  /** Present only for outputs generated with the verified alias-manifest contract. */
  readonly citationVersion?: 2;
  readonly citationStatus: NarrativeCitationStatus;
  readonly title: string;
  readonly focus: string;
  readonly chapters: ReadonlyArray<NarrativeChapter>;
  readonly support: NarrativeSupport;
};

/** Reasons a model result is rejected before it can reach the renderer. */
export type NarrativeWalkthroughError = {
  readonly _tag: "InvalidNarrativeWalkthrough";
  readonly reason:
    | "malformed"
    | "malformed_snapshot"
    | "stale_snapshot"
    | "invalid_patch"
    | "bounds"
    | "empty_primary";
};

const MAX_TITLE_LENGTH = 200;
const MAX_FOCUS_LENGTH = 2_000;
const MAX_CHAPTER_TITLE_LENGTH = 80;
const MAX_SECTION_TITLE_LENGTH = 160;
const MAX_PROSE_LENGTH = 4_000;
const MAX_CHAPTERS = 12;
const MAX_SECTIONS = 32;
const MAX_HUNKS_PER_SECTION = 32;
const MAX_HUNK_ALIAS_LENGTH = 32;
const MAX_SNAPSHOT_ID_LENGTH = 400;
const HUNK_ALIAS_SYNTAX = /^h[1-9]\d*$/;

const boundedText = (maxLength: number) =>
  v.pipe(v.string(), v.maxLength(maxLength));
const boundedHunkIds = v.pipe(
  v.array(boundedText(MAX_HUNK_ALIAS_LENGTH)),
  v.maxLength(MAX_HUNKS_PER_SECTION),
);
const rawSnapshotSchema = v.object({
  profileId: boundedText(128),
  sessionId: boundedText(256),
  headSha: boundedText(128),
  patchHash: boundedText(128),
});

const rawSectionSchema = v.object({
  title: boundedText(MAX_SECTION_TITLE_LENGTH),
  prose: boundedText(MAX_PROSE_LENGTH),
  hunkIds: boundedHunkIds,
});

const rawChapterSchema = v.object({
  title: boundedText(MAX_CHAPTER_TITLE_LENGTH),
  sections: v.pipe(v.array(rawSectionSchema), v.maxLength(MAX_SECTIONS)),
});

const rawWalkthroughSchema = v.object({
  citationVersion: v.optional(v.literal(2)),
  title: boundedText(MAX_TITLE_LENGTH),
  focus: boundedText(MAX_FOCUS_LENGTH),
  chapters: v.pipe(v.array(rawChapterSchema), v.maxLength(MAX_CHAPTERS)),
  snapshot: v.optional(rawSnapshotSchema),
  snapshotId: v.optional(boundedText(MAX_SNAPSHOT_ID_LENGTH)),
});

type RawWalkthrough = v.InferOutput<typeof rawWalkthroughSchema>;

function invalid(
  reason: NarrativeWalkthroughError["reason"],
): Result<never, NarrativeWalkthroughError> {
  return err({ _tag: "InvalidNarrativeWalkthrough", reason });
}

function parseSnapshot(
  input: unknown,
): Result<NarrativeSnapshot, NarrativeWalkthroughError> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return invalid("malformed_snapshot");
  }

  const parsed = v.safeParse(
    v.object({
      profileId: v.unknown(),
      sessionId: v.unknown(),
      headSha: v.unknown(),
      patchHash: v.unknown(),
    }),
    input,
  );
  if (!parsed.success) return invalid("malformed_snapshot");

  const profileId = parseWorkspaceProfileId(parsed.output.profileId);
  const sessionId = parseReviewSessionId(parsed.output.sessionId);
  const headSha = parseGitSha(parsed.output.headSha);
  const patchHash = parseContentHash(parsed.output.patchHash);
  if (
    profileId._tag === "err" ||
    sessionId._tag === "err" ||
    headSha._tag === "err" ||
    patchHash._tag === "err"
  ) {
    return invalid("malformed_snapshot");
  }

  return ok({
    profileId: profileId.value,
    sessionId: sessionId.value,
    headSha: headSha.value,
    patchHash: patchHash.value,
  });
}

function sameSnapshot(
  left: NarrativeSnapshot,
  right: NarrativeSnapshot,
): boolean {
  return (
    left.profileId === right.profileId &&
    left.sessionId === right.sessionId &&
    left.headSha === right.headSha &&
    left.patchHash === right.patchHash
  );
}

function snapshotId(snapshot: NarrativeSnapshot): string {
  return [
    snapshot.profileId,
    snapshot.sessionId,
    snapshot.headSha,
    snapshot.patchHash,
  ].join(":");
}

function normalizeText(value: string): string {
  return value.trim();
}

function hunkMap(
  hunks: ReadonlyArray<NarrativePatchHunk>,
): ReadonlyMap<string, NarrativePatchHunk> {
  return new Map(hunks.map((hunk) => [hunk.id, hunk]));
}

function validateRawSnapshot(
  raw: RawWalkthrough,
  snapshot: NarrativeSnapshot,
): NarrativeWalkthroughError["reason"] | undefined {
  if (raw.snapshot !== undefined) {
    const parsed = parseSnapshot(raw.snapshot);
    if (parsed._tag === "err") return parsed.error.reason;
    if (!sameSnapshot(parsed.value, snapshot)) return "stale_snapshot";
  }
  if (
    raw.snapshotId !== undefined &&
    raw.snapshotId !== snapshot.sessionId &&
    raw.snapshotId !== snapshotId(snapshot)
  ) {
    return "stale_snapshot";
  }
  return undefined;
}

function isWithinBounds(raw: RawWalkthrough): boolean {
  if (
    raw.title.length > MAX_TITLE_LENGTH ||
    raw.focus.length > MAX_FOCUS_LENGTH ||
    raw.chapters.length > MAX_CHAPTERS
  ) {
    return false;
  }
  let sectionCount = 0;
  for (const chapter of raw.chapters) {
    if (
      chapter.title.length > MAX_CHAPTER_TITLE_LENGTH ||
      chapter.sections.length === 0
    )
      return false;
    sectionCount += chapter.sections.length;
    if (sectionCount > MAX_SECTIONS) return false;
    for (const section of chapter.sections) {
      if (
        section.title.length > MAX_SECTION_TITLE_LENGTH ||
        section.prose.length > MAX_PROSE_LENGTH ||
        section.hunkIds.length > MAX_HUNKS_PER_SECTION ||
        section.hunkIds.some((id) => id.length > 32)
      ) {
        return false;
      }
    }
  }
  return true;
}

function normalizedHunk(hunk: NarrativePatchHunk): NarrativeHunk {
  return {
    id: hunk.id,
    path: hunk.path,
    header: hunk.header,
    raw: hunk.raw,
    ...definedProps({ filePrefix: hunk.filePrefix }),
    oldStart: hunk.oldStart,
    oldLines: hunk.oldLines,
    newStart: hunk.newStart,
    newLines: hunk.newLines,
  };
}

/** Normalize untrusted structured output against one immutable patch snapshot. */
export function normalizeNarrativeWalkthrough(
  raw: unknown,
  patch: string,
  snapshot: NarrativeSnapshot,
): Result<NarrativeWalkthrough, NarrativeWalkthroughError> {
  const parsedSnapshot = parseSnapshot(snapshot);
  if (parsedSnapshot._tag === "err") return parsedSnapshot;
  const parsedRaw = v.safeParse(rawWalkthroughSchema, raw);
  if (!parsedRaw.success) return invalid("malformed");
  const input = parsedRaw.output;
  const snapshotError = validateRawSnapshot(input, parsedSnapshot.value);
  if (snapshotError !== undefined) return invalid(snapshotError);
  if (!isWithinBounds(input)) return invalid("bounds");
  const parsedPatch = parseNarrativePatch(patch);
  if (parsedPatch._tag === "err") return parsedPatch;

  const byAlias = hunkMap(parsedPatch.value.hunks);
  const citationVersion = input.citationVersion === 2;
  const covered = new Set<string>();
  const chapters: Array<NarrativeChapter> = [];
  let sectionNumber = 1;
  let rejectedCitationCount = 0;

  for (const [chapterIndex, chapter] of input.chapters.entries()) {
    const sections: Array<NarrativeSection> = [];
    for (const section of chapter.sections) {
      const ids: Array<string> = [];
      const hunks: Array<NarrativeHunk> = [];
      for (const alias of section.hunkIds) {
        if (!HUNK_ALIAS_SYNTAX.test(alias) || covered.has(alias)) continue;
        const hunk = byAlias.get(alias);
        if (hunk === undefined) continue;
        if (
          !citationVersion ||
          !section.prose
            .toLocaleLowerCase()
            .includes(hunk.path.toLocaleLowerCase())
        ) {
          rejectedCitationCount += 1;
          continue;
        }
        covered.add(alias);
        ids.push(alias);
        hunks.push(normalizedHunk(hunk));
      }
      if (ids.length === 0 && citationVersion) {
        if (section.hunkIds.length > 0) rejectedCitationCount += 1;
        continue;
      }
      sections.push({
        id: `section-${sectionNumber}`,
        title: normalizeText(section.title),
        prose: normalizeText(section.prose),
        hunkIds: ids,
        hunks,
      });
      sectionNumber += 1;
    }
    if (sections.length > 0) {
      chapters.push({
        id: `chapter-${chapterIndex + 1}`,
        title: normalizeText(chapter.title),
        sections,
      });
    }
  }

  if (chapters.length === 0) return invalid("empty_primary");
  const supportHunks = parsedPatch.value.hunks.filter(
    (hunk) => !covered.has(hunk.id),
  );
  return ok({
    snapshot: parsedSnapshot.value,
    ...definedProps({
      citationVersion: citationVersion ? (2 as const) : undefined,
    }),
    citationStatus: !citationVersion
      ? "unverified"
      : rejectedCitationCount > 0
        ? "partially_verified"
        : "verified",
    title: normalizeText(input.title),
    focus: normalizeText(input.focus),
    chapters,
    support: {
      id: "support",
      title: "Support",
      hunkIds: supportHunks.map((hunk) => hunk.id),
      hunks: supportHunks.map(normalizedHunk),
    },
  });
}

/** Returns the immutable alias-to-source manifest supplied to the walkthrough model. */
export function narrativeHunkManifest(patch: string): Result<
  ReadonlyArray<{
    readonly id: string;
    readonly path: RepoRelativePath;
    readonly header: string;
  }>,
  NarrativeWalkthroughError
> {
  const parsed = parseNarrativePatch(patch);
  if (parsed._tag === "err") return parsed;
  return ok(
    parsed.value.hunks.map((hunk) => ({
      id: hunk.id,
      path: hunk.path,
      header: hunk.header,
    })),
  );
}

/** Filter an immutable unified patch to known hunk aliases while preserving file headers and hunk order. */
export function filterNarrativePatchToHunks(
  patch: string,
  hunkIds: ReadonlyArray<string>,
): string {
  const parsed = parseNarrativePatch(patch);
  if (parsed._tag === "err") return "";
  const requested = new Set(hunkIds);
  const output: Array<string> = [];
  for (const file of parsed.value.files) {
    const selected = file.hunks.filter((hunk) => requested.has(hunk.id));
    if (selected.length === 0) continue;
    output.push(file.prefix, ...selected.map((hunk) => hunk.raw));
  }
  return output.length === 0 ? "" : `${output.join("\n")}\n`;
}
