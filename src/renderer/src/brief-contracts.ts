import * as v from "valibot";

import { classifyChangedPath } from "../../domain/change-scope";
import { definedProps } from "../../domain/defined-props";
import { insightFields, retainedInsightFields } from "./insight-contracts";

/** Mirrors `BRIEF_ALIAS_SYNTAX` in `src/domain/brief.ts`. */
const BRIEF_ALIAS_SYNTAX = /^[hdc][1-9]\d*$/;

/**
 * The renderer's view of one retained Brief.
 *
 * It mirrors `storedBriefSchema` in `src/domain/brief.ts`: a Brief is retained
 * with its citation labels already resolved, so the renderer reads labels, not
 * patch coordinates. A citation `path` is display text here (the chip's file
 * name); the main process is where it passed `parseRepoRelativePath`, and
 * nothing in the reader resolves it against the diff.
 */
const briefCitationSchema = v.strictObject({
  alias: v.pipe(v.string(), v.minLength(1), v.maxLength(16)),
  kind: v.picklist(["hunk", "description", "commit"]),
  label: v.pipe(v.string(), v.maxLength(200)),
  path: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(1_024))),
});

/**
 * The Ownership block. `files` is Patchdesk's own skeleton of the patch, so the
 * renderer draws it as given; `notes` is the only model-written text here.
 */
const briefOwnershipSchema = v.strictObject({
  files: v.array(
    v.strictObject({
      path: v.pipe(v.string(), v.minLength(1), v.maxLength(1_024)),
      status: v.picklist(["added", "removed", "modified", "renamed"]),
      additions: v.pipe(v.number(), v.integer(), v.minValue(0)),
      deletions: v.pipe(v.number(), v.integer(), v.minValue(0)),
    }),
  ),
  notes: v.array(
    v.strictObject({
      path: v.pipe(v.string(), v.minLength(1), v.maxLength(1_024)),
      note: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
    }),
  ),
});

/**
 * The Start here block. The main process already cut this order down to files
 * the patch changes, so the reader draws it as given; the numbering is honest
 * here because the order is the information.
 */
const briefStartHereSchema = v.strictObject({
  lead: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
  order: v.array(
    v.strictObject({
      path: v.pipe(v.string(), v.minLength(1), v.maxLength(1_024)),
      why: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(200))),
    }),
  ),
});

/**
 * The Reach block. Every number here was produced by a `git grep` in the main
 * process, never by the model, and `method`/`hop` travel with the counts so the
 * reader's footer can state how they were made.
 */
/** One outside line naming a Blast radius name; mirrors `BriefReachMention` in `src/domain/brief-reach-mentions.ts`. */
const briefReachMentionSchema = v.strictObject({
  path: v.pipe(v.string(), v.minLength(1), v.maxLength(1_024)),
  line: v.pipe(v.number(), v.integer(), v.minValue(1)),
  enclosing: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(200))),
  kind: v.picklist(["call", "type", "import", "other"]),
});
// Briefs retained before mention sites existed lack both; the reader then draws today's file list.
const briefReachMentionFields = {
  mentions: v.optional(v.array(briefReachMentionSchema)),
  mentionCount: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
};

const briefReachSchema = v.strictObject({
  symbols: v.array(
    v.strictObject({
      name: v.pipe(v.string(), v.minLength(1), v.maxLength(80)),
      outsideCallerFiles: v.pipe(v.number(), v.integer(), v.minValue(0)),
      outsidePaths: v.array(
        v.pipe(v.string(), v.minLength(1), v.maxLength(1_024)),
      ),
      insidePR: v.boolean(),
      // Briefs retained before the Blast radius view lack it; the reader treats them as `changed` so no name is hidden.
      status: v.optional(v.picklist(["new", "changed"])),
      ...briefReachMentionFields,
    }),
  ),
  surfaces: v.array(
    v.strictObject({
      surface: v.pipe(v.string(), v.minLength(1), v.maxLength(80)),
      path: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(1_024))),
    }),
  ),
  untested: v.array(
    v.strictObject({
      path: v.pipe(v.string(), v.minLength(1), v.maxLength(1_024)),
      reason: v.literal("no_test_in_pr"),
    }),
  ),
  removedStillReferenced: v.array(
    v.strictObject({
      name: v.pipe(v.string(), v.minLength(1), v.maxLength(80)),
      paths: v.array(v.pipe(v.string(), v.minLength(1), v.maxLength(1_024))),
      ...briefReachMentionFields,
    }),
  ),
  method: v.literal("text_match"),
  hop: v.literal(1),
});

/**
 * The Flow block: a before/after tree of a runtime sequence. Every tree
 * carries a `kind` -- call_tree, control_flow, component, state, or contract -- mirroring
 * `BriefFlowKind` in `src/domain/brief-flow.ts`. Citations are hunk-only (the
 * main process already restricted them), but a chip draws a Flow citation the
 * same way it draws any other one.
 */
type BriefFlowNodeEntry = {
  readonly label: string;
  readonly change: "added" | "removed" | "unchanged";
  readonly citations: ReadonlyArray<v.InferOutput<typeof briefCitationSchema>>;
  readonly children: ReadonlyArray<BriefFlowNodeEntry>;
};

/**
 * Builds one level of the Flow node schema, the same way the main process
 * bounds it (`flowNodeSchema` in `src/domain/brief-flow.ts`): `childSchema`
 * validates the nodes one level deeper, and `v.never()` at the deepest level
 * forces `children` to be empty there. `safeParse` against the concrete
 * `briefFlowNodeSchema` built below is bounded to three levels at runtime,
 * with no `v.lazy` self-reference and no cycle a JSON-schema conversion
 * would need `$ref`/`$defs` for.
 */
function flowNodeSchema<ChildSchema extends v.GenericSchema>(
  childSchema: ChildSchema,
) {
  return v.strictObject({
    label: v.pipe(v.string(), v.minLength(1), v.maxLength(120)),
    change: v.picklist(["added", "removed", "unchanged"]),
    citations: v.array(briefCitationSchema),
    children: v.array(childSchema),
  });
}

/** Depth 3, the deepest level: its `children` can only be empty. */
const briefFlowLeafSchema = flowNodeSchema(v.never());
/** Depth 2: its `children` are depth-3 leaves. */
const briefFlowMidSchema = flowNodeSchema(briefFlowLeafSchema);
/**
 * Depth 1, a tree's own root nodes: their `children` are depth-2 nodes.
 * Annotated with the hand-written recursive `BriefFlowNodeEntry`, the same
 * way the previous `v.lazy` schema needed to be, so `BriefFlowNode` still
 * types as an ordinary recursive tree for every consumer -- the renderer,
 * `brief-flow-text.ts`, and their tests -- even though this schema's own
 * runtime validation is bounded to three concrete levels.
 */
const briefFlowNodeSchema: v.GenericSchema<BriefFlowNodeEntry> =
  flowNodeSchema(briefFlowMidSchema);

const briefFlowSchema = v.strictObject({
  trees: v.pipe(
    v.array(
      v.strictObject({
        kind: v.picklist([
          "call_tree",
          "control_flow",
          "component",
          "state",
          "contract",
        ]),
        title: v.pipe(v.string(), v.minLength(1), v.maxLength(120)),
        nodes: v.array(briefFlowNodeSchema),
      }),
    ),
    v.minLength(1),
  ),
});

const briefSchema = v.strictObject({
  snapshot: v.strictObject({
    profileId: v.pipe(v.string(), v.minLength(1)),
    sessionId: v.pipe(v.string(), v.minLength(1)),
    headSha: v.pipe(v.string(), v.minLength(7)),
    patchHash: v.pipe(v.string(), v.minLength(1)),
  }),
  citationStatus: v.picklist(["verified", "partially_verified"]),
  /** Absent on a Brief retained before the Ownership block existed. */
  ownership: v.optional(briefOwnershipSchema),
  /** Absent on a Brief retained before the Start here block existed, and whenever no proposed path was a changed file. */
  startHere: v.optional(briefStartHereSchema),
  /** Absent on a Brief retained before the Reach block existed, and whenever the search could not answer. */
  reach: v.optional(briefReachSchema),
  reachUnavailable: v.optional(
    v.picklist([
      "worktree_unavailable",
      "head_mismatch",
      "search_failed",
      "timed_out",
    ]),
  ),
  /** Absent on a Brief retained before this existed, and whenever no cited hunk could be cut. */
  citedHunks: v.optional(
    v.record(
      v.pipe(v.string(), v.regex(BRIEF_ALIAS_SYNTAX)),
      v.pipe(v.string(), v.minLength(1)),
    ),
  ),
  /** Absent on a Brief retained before the Flow block existed, and whenever no tree survived. */
  flow: v.optional(briefFlowSchema),
});

/** The Brief's own Insight projection: the shared run envelope around one Brief. */
export const briefInsightSchema = v.strictObject({
  ...insightFields,
  retained: v.optional(
    v.strictObject({ ...retainedInsightFields, value: briefSchema }),
  ),
});

export type BriefInsight = v.InferOutput<typeof briefInsightSchema>;
export type Brief = v.InferOutput<typeof briefSchema>;
export type BriefCitation = v.InferOutput<typeof briefCitationSchema>;
export type BriefOwnership = v.InferOutput<typeof briefOwnershipSchema>;
export type BriefReach = v.InferOutput<typeof briefReachSchema>;
type BriefReachMention = v.InferOutput<typeof briefReachMentionSchema>;
export type BriefStartHere = v.InferOutput<typeof briefStartHereSchema>;
export type BriefFlow = v.InferOutput<typeof briefFlowSchema>;
export type BriefFlowNode = v.InferOutput<typeof briefFlowNodeSchema>;

/** How the Blast radius counts were made, so no reader mistakes a mention for a call. */
export function briefBlastRadiusFootnote(
  reach: BriefReach,
  headSha: string,
): string {
  const hops = reach.hop === 1 ? "one hop" : `${String(reach.hop)} hops`;
  return `Found by text search for each name at ${headSha.slice(0, 7)}, ${hops} out; a mention is a place to check, not proof of a call.`;
}

/** One list row of the Reach block, including what to say when it lists nothing. */
export type BriefReachRow = {
  readonly label: string;
  readonly hint?: string;
  readonly items: ReadonlyArray<string>;
  readonly empty: string;
};

/** One place a file mentions a name: the declaration it sits in, its kind, and its line. */
type BlastRadiusSite = {
  /** The enclosing declaration, or `top level`. */
  readonly label: string;
  readonly kind: BriefReachMention["kind"];
  readonly line: number;
};

/** One file under a folder, with the sites that mention the name; empty for a Brief stored before sites existed. */
export type BlastRadiusFile = {
  readonly name: string;
  readonly sites: ReadonlyArray<BlastRadiusSite>;
};

/** One folder of a name's outside paths: the folder is printed once, its file names after it. */
export type BlastRadiusFolder = {
  /** Ends in `/`; `./` for a file at the repository root. */
  readonly folder: string;
  /** A folder can hold both source and test files; each side gets its own group. */
  readonly tests: boolean;
  readonly files: ReadonlyArray<BlastRadiusFile>;
};

/** One name in a Blast radius group, with its outside paths already grouped and cut. */
export type BlastRadiusName = {
  readonly name: string;
  readonly count: string;
  /** Every stored path, source folders before test folders. */
  readonly folders: ReadonlyArray<BlastRadiusFolder>;
  /** The first `MAX_COLLAPSED_PATHS` sites (or files, without sites) of `folders`, drawn until the reader asks for more. */
  readonly collapsed: ReadonlyArray<BlastRadiusFolder>;
  /** Stored sites or files `collapsed` leaves out. */
  readonly hidden: number;
  /** Sites or files the search counted past the stored ones. */
  readonly unlisted: number;
};

/** The Blast radius view: riskiest names first, names nothing outside mentions folded. */
export type BriefBlastRadius = {
  readonly summary: string;
  readonly removed: ReadonlyArray<BlastRadiusName>;
  readonly changed: ReadonlyArray<BlastRadiusName>;
  readonly quiet: {
    readonly label: string;
    readonly names: ReadonlyArray<string>;
  };
  readonly untested: BriefReachRow;
};

/** Past five paths one name pushes the next name off screen. */
const MAX_COLLAPSED_PATHS = 5;
/** Past three areas the summary stops being one glance. */
const MAX_SUMMARY_AREAS = 3;

const files = (count: number) =>
  `${String(count)} ${count === 1 ? "file" : "files"}`;

const plural = (count: number, one: string, many: string) =>
  `${String(count)} ${count === 1 ? one : many}`;

const isTestPath = (path: string) =>
  classifyChangedPath({ path, additions: 0, deletions: 0 }) === "tests";

/** `7 source · 2 tests`, leaving out an empty side. */
function sourceTestSplit(paths: ReadonlyArray<string>, separator: string) {
  const tests = paths.filter(isTestPath).length;
  const source = paths.length - tests;
  return [
    source === 0 ? undefined : `${String(source)} source`,
    tests === 0
      ? undefined
      : `${String(tests)} ${tests === 1 ? "test" : "tests"}`,
  ]
    .filter((part) => part !== undefined)
    .join(separator);
}

/** `5 calls · 2 type-only · 2 tests`: source sites by kind, then every test site once. */
function mentionKindSplit(mentions: ReadonlyArray<BriefReachMention>): string {
  const source = mentions.filter((mention) => !isTestPath(mention.path));
  const count = (kind: BriefReachMention["kind"]) =>
    source.filter((mention) => mention.kind === kind).length;
  const tests = mentions.length - source.length;
  return [
    { total: count("call"), one: "call", many: "calls" },
    { total: count("type"), one: "type-only", many: "type-only" },
    { total: count("import"), one: "import", many: "imports" },
    { total: count("other"), one: "other", many: "other" },
    { total: tests, one: "test", many: "tests" },
  ]
    .filter((part) => part.total !== 0)
    .map((part) => plural(part.total, part.one, part.many))
    .join(" · ");
}

const MENTION_KIND_ORDER: ReadonlyArray<BriefReachMention["kind"]> = [
  "call",
  "type",
  "import",
  "other",
];

/** Groups paths by folder, source folders first, keeping first-seen order within each side. */
function groupByFolder(
  paths: ReadonlyArray<string>,
  mentions: ReadonlyArray<BriefReachMention>,
): ReadonlyArray<BlastRadiusFolder> {
  const groups = new Map<
    string,
    { folder: string; tests: boolean; files: Array<BlastRadiusFile> }
  >();
  const ordered = [
    ...paths.filter((path) => !isTestPath(path)),
    ...paths.filter(isTestPath),
  ];
  for (const path of ordered) {
    const cut = path.lastIndexOf("/");
    const folder = cut < 0 ? "./" : path.slice(0, cut + 1);
    const tests = isTestPath(path);
    const key = `${String(tests)}:${folder}`;
    const group = groups.get(key) ?? { folder, tests, files: [] };
    group.files.push({
      name: path.slice(cut + 1),
      sites: sitesIn(path, mentions),
    });
    groups.set(key, group);
  }
  return [...groups.values()];
}

/** One file's sites, calls first, then type, import, and other, each by line. */
function sitesIn(
  path: string,
  mentions: ReadonlyArray<BriefReachMention>,
): ReadonlyArray<BlastRadiusSite> {
  return mentions
    .filter((mention) => mention.path === path)
    .sort(
      (a, b) =>
        MENTION_KIND_ORDER.indexOf(a.kind) -
          MENTION_KIND_ORDER.indexOf(b.kind) || a.line - b.line,
    )
    .map((mention) => ({
      label: mention.enclosing ?? "top level",
      kind: mention.kind,
      line: mention.line,
    }));
}

/** A file draws as its sites, or as one row when it has none. */
const fileUnits = (file: BlastRadiusFile) => Math.max(1, file.sites.length);

/** The first `limit` sites (or bare files) across `folders`, in the order they are drawn. */
function firstUnits(
  folders: ReadonlyArray<BlastRadiusFolder>,
  limit: number,
): ReadonlyArray<BlastRadiusFolder> {
  const kept: Array<BlastRadiusFolder> = [];
  let left = limit;
  for (const group of folders) {
    if (left === 0) break;
    const keptFiles: Array<BlastRadiusFile> = [];
    for (const file of group.files) {
      if (left === 0) break;
      keptFiles.push({ ...file, sites: file.sites.slice(0, left) });
      left -= Math.min(left, fileUnits(file));
    }
    kept.push({ ...group, files: keptFiles });
  }
  return kept;
}

/** One name's view; `mentions` is absent on a Brief stored before sites existed. */
function blastRadiusName(entry: {
  readonly name: string;
  readonly paths: ReadonlyArray<string>;
  readonly totalFiles: number;
  readonly mentions: ReadonlyArray<BriefReachMention> | undefined;
  readonly mentionCount: number | undefined;
  readonly fileCount: string;
}): BlastRadiusName {
  const mentions = entry.mentions ?? [];
  const folders =
    entry.mentions === undefined
      ? groupByFolder(entry.paths, [])
      : groupByFolder(
          [...new Set(mentions.map((mention) => mention.path))],
          mentions,
        );
  const units = folders
    .flatMap((group) => group.files)
    .reduce((total, file) => total + fileUnits(file), 0);
  return {
    name: entry.name,
    count:
      entry.mentions === undefined
        ? entry.fileCount
        : mentionKindSplit(mentions),
    folders,
    collapsed: firstUnits(folders, MAX_COLLAPSED_PATHS),
    hidden: Math.max(0, units - MAX_COLLAPSED_PATHS),
    unlisted:
      entry.mentions === undefined
        ? Math.max(0, entry.totalFiles - entry.paths.length)
        : Math.max(
            0,
            (entry.mentionCount ?? mentions.length) - mentions.length,
          ),
  };
}

/** The first two path segments of a file's folder. */
function areaOf(path: string): string {
  const segments = path.split("/").slice(0, -1);
  return segments.length === 0 ? "./" : segments.slice(0, 2).join("/");
}

/** Path prefixes of the layers `docs/architecture.md` names. */
const LAYER_PREFIXES: ReadonlyArray<readonly [string, string]> = [
  ["src/main/", "main"],
  ["src/services/", "services"],
  ["src/renderer/", "renderer"],
  ["src/adapters/", "adapters"],
  ["src/domain/", "domain"],
  ["runtime/", "runtime"],
];

/** A path's architecture layer, or its area in a repository without those layers. */
function layerOf(path: string): string {
  return (
    LAYER_PREFIXES.find(([prefix]) => path.startsWith(prefix))?.[1] ??
    areaOf(path)
  );
}

/** Labels most frequent first, cut to `MAX_SUMMARY_AREAS`. */
function ranked(labels: ReadonlyArray<string>): string {
  const counts = new Map<string, number>();
  for (const label of labels) counts.set(label, (counts.get(label) ?? 0) + 1);
  const order = [...counts].sort((a, b) => b[1] - a[1]).map(([label]) => label);
  const shown = order.slice(0, MAX_SUMMARY_AREAS).join(", ");
  return order.length > MAX_SUMMARY_AREAS ? `${shown}, …` : shown;
}

const NOTHING_MENTIONED =
  "Nothing outside the changed files mentions a changed name.";

function blastRadiusSummary(
  paths: ReadonlyArray<string>,
  someUnlisted: boolean,
): string {
  if (paths.length === 0) return NOTHING_MENTIONED;
  const source = paths.filter((path) => !isTestPath(path));
  const lead = `${someUnlisted ? "At least " : ""}${files(paths.length)} could be affected`;
  return `${lead} · ${sourceTestSplit(paths, ", ")} · in ${ranked((source.length === 0 ? paths : source).map(areaOf))}`;
}

/** The summary by mention site: functions that call a changed name lead, then type-only mentions, then the layers they sit in. */
function mentionSummary(
  mentions: ReadonlyArray<BriefReachMention>,
  someUnlisted: boolean,
): string {
  const source = mentions.filter((mention) => !isTestPath(mention.path));
  const callers = new Set(
    source.flatMap((mention) =>
      mention.kind === "call"
        ? [`${mention.path}\0${mention.enclosing ?? ""}`]
        : [],
    ),
  ).size;
  const types = source.filter((mention) => mention.kind === "type").length;
  const parts = [
    callers === 0
      ? undefined
      : `${plural(callers, "function calls", "functions call")} a changed name`,
    types === 0
      ? undefined
      : plural(types, "type-only mention", "type-only mentions"),
  ].filter((part) => part !== undefined);
  if (parts.length === 0)
    parts.push(
      source.length === 0
        ? plural(mentions.length, "test mention", "test mentions")
        : plural(source.length, "mention", "mentions"),
    );
  if (source.length > 0)
    parts.push(`in ${ranked(source.map((mention) => layerOf(mention.path)))}`);
  return `${someUnlisted ? "At least " : ""}${parts.join(" · ")}`;
}

/**
 * Turns the counted block into the Blast radius view. Every number here was
 * produced by the main process; this only orders, groups, and words it.
 */
export function briefBlastRadius(reach: BriefReach): BriefBlastRadius {
  const removed = reach.removedStillReferenced.map((item) =>
    blastRadiusName({
      name: item.name,
      paths: item.paths,
      totalFiles: item.paths.length,
      mentions: item.mentions,
      mentionCount: item.mentionCount,
      fileCount: files(item.paths.length),
    }),
  );
  const mentioned = reach.symbols
    .filter((symbol) => symbol.outsideCallerFiles > 0)
    .sort((a, b) => b.outsideCallerFiles - a.outsideCallerFiles);
  const changed = mentioned.map((symbol) =>
    blastRadiusName({
      name: symbol.name,
      paths: symbol.outsidePaths,
      totalFiles: symbol.outsideCallerFiles,
      mentions: symbol.mentions,
      mentionCount: symbol.mentionCount,
      fileCount: sourceTestSplit(symbol.outsidePaths, " · "),
    }),
  );
  const quiet = reach.symbols.filter(
    (symbol) => symbol.outsideCallerFiles === 0,
  );
  const quietNew = quiet.filter((symbol) => symbol.status === "new").length;
  const quietSplit = [
    quietNew === 0 ? undefined : `${String(quietNew)} new`,
    quiet.length === quietNew
      ? undefined
      : `${String(quiet.length - quietNew)} changed`,
  ]
    .filter((part) => part !== undefined)
    .join(", ");
  const listed = [...reach.removedStillReferenced, ...mentioned];
  const mentions = listed.flatMap((item) => item.mentions ?? []);
  const someUnlisted = [...removed, ...changed].some(
    (name) => name.unlisted > 0,
  );
  // A Brief stored before mention sites existed, or one whose site budget ran out, is summarised by file.
  const bySite =
    mentions.length > 0 && listed.every((item) => item.mentions !== undefined);
  return {
    summary: bySite
      ? mentionSummary(mentions, someUnlisted)
      : blastRadiusSummary(
          [
            ...new Set([
              ...reach.removedStillReferenced.flatMap((item) => item.paths),
              ...mentioned.flatMap((symbol) => symbol.outsidePaths),
            ]),
          ],
          changed.some((name) => name.unlisted > 0),
        ),
    removed,
    changed,
    quiet: {
      label: `${String(quiet.length)} ${quiet.length === 1 ? "name" : "names"} nothing outside the changed files mentions (${quietSplit})`,
      names: quiet.map((symbol) => symbol.name),
    },
    untested: {
      label: "No matching test",
      hint: "no changed test file matches it by name, folder, or mention",
      empty: "Every changed file matches a changed test file.",
      items: reach.untested.map((item) => item.path),
    },
  };
}

/** Why the Blast radius view is missing, in the one line the reader shows in its place. */
export const BRIEF_REACH_UNAVAILABLE_LABELS = {
  worktree_unavailable: "worktree unreadable",
  head_mismatch: "worktree revision changed",
  search_failed: "search failed",
  timed_out: "search timed out",
} as const satisfies Record<NonNullable<Brief["reachUnavailable"]>, string>;

/** A Brief the projection did not carry reads as one that was never generated. */
export const NOT_GENERATED_BRIEF: BriefInsight = { status: "not_generated" };

/**
 * The short text one citation chip carries. The manifest label is the whole
 * evidence -- a paragraph, a commit subject, a hunk header -- so the chip shows
 * the shortest thing that names it and the full label stays in the chip title.
 *
 * A hunk chip is its alias alone (`h3`): Flow rows repeat the same file many
 * times, so the file lives in the chip's accessible name and title instead.
 */
export function briefCitationChipLabel(citation: BriefCitation): string {
  if (citation.kind === "description")
    return `desc ¶${citation.alias.slice(1)}`;
  if (citation.kind === "commit")
    return citation.label.split(" ")[0] ?? citation.alias;
  return citation.alias;
}

/** What a chip is called to assistive technology: a hunk chip names its file (`repository.go · h3`), which its visible alias leaves out. */
export function briefCitationChipName(citation: BriefCitation): string {
  if (citation.kind !== "hunk" || citation.path === undefined)
    return briefCitationChipLabel(citation);
  return `${citation.path.slice(citation.path.lastIndexOf("/") + 1)} · ${citation.alias}`;
}

/**
 * The whole evidence one citation chip stands for, shown on hover. A hunk chip
 * shows only its alias, so the title carries the path back.
 */
export function briefCitationChipTitle(citation: BriefCitation): string {
  const source =
    citation.path === undefined
      ? citation.label
      : `${citation.path} ${citation.label}`;
  return `${citation.kind}: ${source}`;
}

/** One line of the Ownership tree: a changed file, how it changed, and its note. */
export type BriefOwnershipRow = {
  readonly path: string;
  /** The file name alone; the directory is printed once, on the group above. */
  readonly name: string;
  readonly status: BriefOwnership["files"][number]["status"];
  readonly note?: string;
};

/** One directory of the Ownership tree, already cut to what the reader draws. */
export type BriefOwnershipDirectory = {
  /** `""` for a file at the repository root. */
  readonly directory: string;
  readonly files: ReadonlyArray<BriefOwnershipRow>;
  /** Files past the collapse limit, reported as a count instead of drawn. */
  readonly hidden: number;
};

/** Past this many files, one directory would push the rest of the tree off screen. */
const MAX_OWNERSHIP_DIRECTORY_FILES = 12;

/**
 * Groups the Ownership skeleton into the directory rows the tree draws, keeping the
 * skeleton's path order. A directory with more than 12 files is cut to 12 and
 * reports the rest as a count, so a wide directory cannot bury the others.
 */
export function briefOwnershipTree(
  ownership: BriefOwnership,
): ReadonlyArray<BriefOwnershipDirectory> {
  const notes = new Map(ownership.notes.map((note) => [note.path, note.note]));
  const groups = new Map<string, Array<BriefOwnershipRow>>();
  for (const file of ownership.files) {
    const cut = file.path.lastIndexOf("/");
    const directory = cut < 0 ? "" : file.path.slice(0, cut + 1);
    const rows = groups.get(directory) ?? [];
    rows.push({
      path: file.path,
      name: file.path.slice(cut + 1),
      status: file.status,
      ...definedProps({ note: notes.get(file.path) }),
    });
    groups.set(directory, rows);
  }
  return [...groups].map(([directory, rows]) => ({
    directory,
    files: rows.slice(0, MAX_OWNERSHIP_DIRECTORY_FILES),
    hidden: Math.max(0, rows.length - MAX_OWNERSHIP_DIRECTORY_FILES),
  }));
}

/**
 * States the Brief's citation status alone (ADR 0040). A surviving citation
 * only proves its hunk exists in the diff, not that the step it supports is
 * right, so the line claims no more than "found". A partial status also counts
 * rejected Ownership and Start here paths, so it cannot blame hunks alone.
 */
export function briefCitationStatusLine(brief: Brief): string {
  if (brief.citationStatus === "partially_verified")
    return "some citations or file paths could not be matched to the diff";
  const cited = (nodes: ReadonlyArray<BriefFlowNodeEntry>): boolean =>
    nodes.some((node) => node.citations.length > 0 || cited(node.children));
  return brief.flow?.trees.some((tree) => cited(tree.nodes)) === true
    ? "all cited hunks found in the diff"
    : "no hunks cited";
}
