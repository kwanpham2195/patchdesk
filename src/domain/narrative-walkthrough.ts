import * as v from "valibot";

import {
  parseContentHash,
  parseGitSha,
  parseRepoRelativePath,
  parseReviewSessionId,
  parseWorkspaceProfileId,
  type ContentHash,
  type GitSha,
  type RepoRelativePath,
  type ReviewSessionId,
  type WorkspaceProfileId,
} from "./ids";
import { err, ok, type Result } from "./result";

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
export type NarrativeSection = {
  readonly id: string;
  readonly title: string;
  readonly prose: string;
  readonly hunkIds: ReadonlyArray<string>;
  readonly hunks: ReadonlyArray<NarrativeHunk>;
};

/** An ordered chapter in the persistent walkthrough rail. */
export type NarrativeChapter = {
  readonly id: string;
  readonly title: string;
  readonly sections: ReadonlyArray<NarrativeSection>;
};

/** The derived Support group containing every hunk outside the primary path. */
export type NarrativeSupport = {
  readonly id: "support";
  readonly title: "Support";
  readonly hunkIds: ReadonlyArray<string>;
  readonly hunks: ReadonlyArray<NarrativeHunk>;
};

/** A normalized, snapshot-bound walkthrough ready for renderer projection. */
export type NarrativeCitationStatus =
  | "verified"
  | "partially_verified"
  | "unverified";

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
const MAX_PATCH_LINE_COORDINATE = 1_000_000;
const MAX_HUNK_LINE_COUNT = 100_000;
const MAX_HUNK_RAW_LENGTH = 200_000;
/** Keeps patch file metadata safe and aligned with the renderer projection boundary. */
export const MAX_NARRATIVE_FILE_PREFIX_LENGTH = 8_192;
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
type HunkRange = {
  readonly oldStart: number;
  readonly oldLines: number;
  readonly newStart: number;
  readonly newLines: number;
};

type ParsedHunk = NarrativeHunk & {
  readonly filePrefix: string;
};

type ParsedPatchFile = {
  readonly prefix: string;
  readonly hunks: ReadonlyArray<ParsedHunk>;
};

type ParsedPatch = {
  readonly files: ReadonlyArray<ParsedPatchFile>;
  readonly hunks: ReadonlyArray<ParsedHunk>;
};

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

function parseDiffPath(
  value: string,
): Result<RepoRelativePath, NarrativeWalkthroughError> {
  const normalized =
    value === "/dev/null"
      ? "dev/null"
      : value.replace(/^a\//, "").replace(/^b\//, "");
  const path = parseRepoRelativePath(normalized);
  return path._tag === "err" ? invalid("invalid_patch") : ok(path.value);
}

function parseHunkHeader(line: string): HunkRange | undefined {
  const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
  if (match === null) return undefined;
  const oldStart = Number(match[1]);
  const oldLines = Number(match[2] ?? "1");
  const newStart = Number(match[3]);
  const newLines = Number(match[4] ?? "1");
  if (![oldStart, oldLines, newStart, newLines].every(Number.isSafeInteger))
    return undefined;
  if (!validRange(oldStart, oldLines) || !validRange(newStart, newLines)) {
    return undefined;
  }
  return { oldStart, oldLines, newStart, newLines };
}

function validRange(start: number, lines: number): boolean {
  if (
    start < 0 ||
    lines < 0 ||
    start > MAX_PATCH_LINE_COORDINATE ||
    lines > MAX_HUNK_LINE_COUNT
  ) {
    return false;
  }
  return lines === 0 || start > 0;
}

function countHunkBody(
  lines: ReadonlyArray<string>,
  start: number,
  end: number,
): { readonly oldLines: number; readonly newLines: number } | undefined {
  let oldLines = 0;
  let newLines = 0;
  let sawContent = false;
  for (let index = start; index < end; index += 1) {
    const line = lines[index];
    if (line === undefined) return undefined;
    if (line === "\\ No newline at end of file") {
      if (!sawContent) return undefined;
      continue;
    }
    const marker = line[0];
    if (marker === " ") {
      oldLines += 1;
      newLines += 1;
      sawContent = true;
      continue;
    }
    if (marker === "-") {
      oldLines += 1;
      sawContent = true;
      continue;
    }
    if (marker === "+") {
      newLines += 1;
      sawContent = true;
      continue;
    }
    return undefined;
  }
  return { oldLines, newLines };
}

function validHunkBody(
  lines: ReadonlyArray<string>,
  start: number,
  end: number,
  range: HunkRange,
): boolean {
  const counted = countHunkBody(lines, start, end);
  return (
    counted !== undefined &&
    counted.oldLines === range.oldLines &&
    counted.newLines === range.newLines
  );
}

function parseNarrativePatch(
  patch: string,
): Result<ParsedPatch, NarrativeWalkthroughError> {
  if (patch.length === 0) return invalid("invalid_patch");
  const lines = (patch.endsWith("\n") ? patch.slice(0, -1) : patch).split("\n");
  const files: Array<{
    readonly start: number;
    prefixEnd: number | undefined;
    hunks: Array<{
      readonly start: number;
      end: number;
      header: string;
      range: HunkRange;
      path: RepoRelativePath;
    }>;
  }> = [];
  let current: (typeof files)[number] | undefined;
  let currentPath: RepoRelativePath | undefined;
  let currentHunkStart: number | undefined;

  const finishHunk = (end: number): boolean => {
    if (
      current === undefined ||
      currentHunkStart === undefined ||
      currentPath === undefined
    )
      return true;
    const header = lines[currentHunkStart];
    if (header === undefined) return false;
    const range = parseHunkHeader(header);
    if (
      range === undefined ||
      !validHunkBody(lines, currentHunkStart + 1, end, range)
    )
      return false;
    const raw = lines.slice(currentHunkStart, end).join("\n");
    if (raw.length > MAX_HUNK_RAW_LENGTH) return false;
    current.hunks.push({
      start: currentHunkStart,
      end,
      header,
      range,
      path: currentPath,
    });
    currentHunkStart = undefined;
    return true;
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const fileHeader = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
    if (fileHeader !== null) {
      if (!finishHunk(index)) return invalid("invalid_patch");
      const path = parseDiffPath(fileHeader[2] ?? "");
      if (path._tag === "err") return path;
      current = { start: index, prefixEnd: undefined, hunks: [] };
      files.push(current);
      currentPath = path.value;
      continue;
    }
    // Git emits bare submodule-change lines without a diff header (for example
    // "Submodule yim-proto-hub 00000000...4619420d (new submodule)"). They are
    // metadata, not hunk body; close any open hunk and skip the line.
    if (
      /^Submodule [^\s]+ [0-9a-f]+\.{2,3}[0-9a-f]+(?: \([^)]*\))?$/.test(line)
    ) {
      if (!finishHunk(index)) return invalid("invalid_patch");
      continue;
    }
    if (current === undefined) continue;
    const hunkRange = parseHunkHeader(line);
    if (line.startsWith("@@ ") && hunkRange === undefined)
      return invalid("invalid_patch");
    if (hunkRange !== undefined) {
      if (!finishHunk(index)) return invalid("invalid_patch");
      current.prefixEnd ??= index;
      currentHunkStart = index;
      continue;
    }
    if (currentHunkStart !== undefined && line.startsWith("diff --git ")) {
      if (!finishHunk(index)) return invalid("invalid_patch");
    }
    if (currentPath === undefined) continue;
  }
  if (!finishHunk(lines.length)) return invalid("invalid_patch");

  const parsedFiles: Array<ParsedPatchFile> = [];
  const parsedHunks: Array<ParsedHunk> = [];
  let nextAlias = 1;
  for (const file of files) {
    if (file.hunks.length === 0) continue;
    const prefixEnd = file.prefixEnd ?? file.hunks[0]?.start ?? file.start;
    const prefix = lines.slice(file.start, prefixEnd).join("\n");
    if (prefix.length > MAX_NARRATIVE_FILE_PREFIX_LENGTH)
      return invalid("invalid_patch");
    const hunks: Array<ParsedHunk> = [];
    for (const hunk of file.hunks) {
      const raw = lines
        .slice(hunk.start, hunk.end)
        .join("\n")
        .replace(/\n+$/, "");
      const parsed: ParsedHunk = {
        id: `h${nextAlias}`,
        path: hunk.path,
        header: hunk.header,
        raw,
        oldStart: hunk.range.oldStart,
        oldLines: hunk.range.oldLines,
        newStart: hunk.range.newStart,
        newLines: hunk.range.newLines,
        filePrefix: prefix,
      };
      nextAlias += 1;
      hunks.push(parsed);
      parsedHunks.push(parsed);
    }
    parsedFiles.push({ prefix, hunks });
  }

  return parsedHunks.length === 0
    ? invalid("invalid_patch")
    : ok({ files: parsedFiles, hunks: parsedHunks });
}

function hunkMap(
  hunks: ReadonlyArray<ParsedHunk>,
): ReadonlyMap<string, ParsedHunk> {
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

function normalizedHunk(hunk: ParsedHunk): NarrativeHunk {
  return {
    id: hunk.id,
    path: hunk.path,
    header: hunk.header,
    raw: hunk.raw,
    ...(hunk.filePrefix === undefined ? {} : { filePrefix: hunk.filePrefix }),
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
    ...(citationVersion ? { citationVersion: 2 as const } : {}),
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
