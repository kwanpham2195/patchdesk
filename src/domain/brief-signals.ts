import { isUnchangedRename } from "./brief-ownership";
import { classifyChangedPath, type ChangeScopeBucket } from "./change-scope";
import { definedProps } from "./defined-props";
import type { PatchChangedFile } from "./patch-changed-files";
import { tokenizeUnifiedPatch } from "./unified-patch";

/*
 * The Brief reader draws this block as "Signals": a fixed set of checks a
 * reviewer wants before opening a file (#721). Every row is always present,
 * with a count of zero when nothing matched, and Patchdesk computes each one
 * from the patch; the model writes none of it.
 */

export const BRIEF_SIGNAL_KINDS = [
  "public_api",
  "routes",
  "stored_data",
  "security_boundary",
  "dependencies",
  "config_or_deploy",
  "tests_weakened",
  "tests_added",
  "concurrency",
  "skimmable",
] as const;

export type BriefSignalKind = (typeof BRIEF_SIGNAL_KINDS)[number];

/** One row: how many matched, a short breakdown, and the first paths that matched. */
export type BriefSignal = {
  readonly kind: BriefSignalKind;
  readonly count: number;
  readonly paths: ReadonlyArray<string>;
  readonly detail?: string;
};

/** How each row reads, shared by the reader and the PR-description export. */
export const BRIEF_SIGNAL_LABELS = {
  public_api: "Public API",
  routes: "Routes",
  stored_data: "Stored data",
  security_boundary: "Security boundary",
  dependencies: "Dependencies",
  config_or_deploy: "Config or deploy",
  tests_weakened: "Tests weakened",
  tests_added: "Tests added",
  concurrency: "Concurrency",
  skimmable: "To skim",
} as const satisfies Record<BriefSignalKind, string>;

/** The reader's row groups, in drawing order. */
export const BRIEF_SIGNAL_GROUPS: ReadonlyArray<{
  readonly title: string;
  readonly kinds: ReadonlyArray<BriefSignalKind>;
}> = [
  {
    title: "Areas",
    kinds: [
      "public_api",
      "routes",
      "stored_data",
      "security_boundary",
      "dependencies",
      "config_or_deploy",
    ],
  },
  { title: "Tests", kinds: ["tests_weakened", "tests_added"] },
  {
    title: "Code",
    kinds: ["concurrency", "skimmable"],
  },
];

/** A lit row that asks for a closer look; `tests_added` and `skimmable` only inform. */
export function briefSignalWarns(kind: BriefSignalKind): boolean {
  return kind !== "tests_added" && kind !== "skimmable";
}

const MAX_SIGNAL_PATHS = 5;
/** Fewer snapshot files than this is an ordinary update, not a bulk one. */
const BULK_SNAPSHOT_FILES = 5;

const LOCKFILES = new Set([
  "pnpm-lock.yaml",
  "package-lock.json",
  "yarn.lock",
  "bun.lockb",
  "go.sum",
  "Cargo.lock",
  "poetry.lock",
  "Gemfile.lock",
]);
const MANIFESTS = new Set([
  "package.json",
  "go.mod",
  "Cargo.toml",
  "requirements.txt",
  "pyproject.toml",
  "Gemfile",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
]);
const SECURITY_WORDS =
  /auth|permission|rbac|acl|credential|oauth|jwt|sandbox|secret|password/i;
const CONFIG_EXTENSIONS = /\.(?:json|ya?ml|toml|ini|env|properties)$/;
/**
 * A route registration: a router or server receiver, a path string, then a
 * handler, such as `r.POST("/roles", h.Create)`; or a protobuf `rpc` line.
 */
const ROUTE_LINE =
  /\b(?:http|r|router|mux|e|g|group|app|server)\.(?:HandleFunc|Handle|GET|POST|PUT|PATCH|DELETE|Get|Post|Put|Patch|Delete|get|post|put|patch|delete|route|Route)\(\s*['"`][^'"`]*['"`]\s*,|^\s*rpc\s+\w+\s*\(/;
/** An assertion call or a matcher such as `.toBe(` or `.to.equal(`; `.toString(` is not one. */
const ASSERTION =
  /\b(?:expect|assert\w*|require\.\w+|t\.(?:Error|Errorf|Fatal|Fatalf))\s*\(|\.(?:to(?:Be|Equal|StrictEqual|Match|Have|Throw|Contain|Satisfy|Resolve|Reject)\w*|to\.\w+|should\.\w+)/;
const SKIPPED_TEST =
  /\b(?:it|test|describe)\.(?:skip|todo|only)\(|\b[xf](?:it|test|describe)\(|\bt\.Skip(?:Now|f)?\(|@Disabled|@Ignore|pytest\.mark\.skip/;
const TEST_CASE = /\b(?:it|test)\(\s*['"`]|\bfunc Test\w*\(|\bdef test_\w*\(/;
/** A goroutine, channel, lock, atomic, `select`, or JavaScript fan-out and timer. */
const CONCURRENCY =
  /^\s*go\s+(?:func\b|\w+[.(])|\bsync\.\w+|\bchan\b|^\s*select\s*\{|\batomic\.\w+|\bPromise\.(?:all|race|any|allSettled)\(|\bsetInterval\(|\bnew Worker\(/;
type FileText = {
  readonly added: Array<string>;
  readonly removed: Array<string>;
};

type Tally = { count: number; paths: Array<string> };

/**
 * Every Signals row for one patch, in `BRIEF_SIGNAL_KINDS` order. A file
 * that only moved, a file that only follows a move (`referenceUpdatePaths`),
 * and a generated file raise no row but `skimmable`.
 */
export function briefSignals(
  patch: string,
  files: ReadonlyArray<PatchChangedFile>,
  referenceUpdatePaths: ReadonlyArray<string>,
): ReadonlyArray<BriefSignal> {
  const text = changedText(patch);
  const followsMove = new Set(referenceUpdatePaths);
  const tallies = new Map<BriefSignalKind, Tally>(
    BRIEF_SIGNAL_KINDS.map((kind) => [kind, { count: 0, paths: [] }]),
  );
  const add = (kind: BriefSignalKind, path: string, count = 1) => {
    const tally = tallies.get(kind);
    if (tally === undefined || count <= 0) return;
    tally.count += count;
    if (!tally.paths.includes(path)) tally.paths.push(path);
  };

  const skim = { moved: 0, followsMove: 0, generated: 0 };
  const weakened = { deleted: 0, assertions: 0, skipped: 0 };
  const routes = { added: 0, removed: 0 };
  let newTestFiles = 0;
  let lockfilesOnly = true;
  const snapshots: Array<string> = [];

  for (const file of files) {
    const bucket = classifyChangedPath(file);
    const name = file.path.split("/").at(-1) ?? "";
    const lines = text.get(file.path) ?? { added: [], removed: [] };
    if (isUnchangedRename(file)) skim.moved += 1;
    else if (followsMove.has(file.path)) skim.followsMove += 1;
    else if (bucket === "generated" && !LOCKFILES.has(name))
      skim.generated += 1;
    else {
      for (const kind of areas(file.path, name, bucket)) add(kind, file.path);
      // Only an edited snapshot can hide a weakened test; a new one comes with a new test.
      if (file.status === "modified" && isSnapshot(file.path))
        snapshots.push(file.path);
      if (MANIFESTS.has(name)) lockfilesOnly = false;
      if (bucket === "tests") {
        if (file.status === "removed") {
          weakened.deleted += 1;
          add("tests_weakened", file.path);
        } else {
          const lost =
            countMatches(lines.removed, ASSERTION) -
            countMatches(lines.added, ASSERTION);
          const skipped = countMatches(lines.added, SKIPPED_TEST);
          weakened.assertions += Math.max(0, lost);
          weakened.skipped += skipped;
          add("tests_weakened", file.path, Math.max(0, lost) + skipped);
          if (file.status === "added") newTestFiles += 1;
          const cases =
            countMatches(lines.added, TEST_CASE) -
            countMatches(lines.removed, TEST_CASE);
          add(
            "tests_added",
            file.path,
            Math.max(cases, file.status === "added" ? 1 : 0),
          );
        }
      } else if (bucket === "core" && !isTestDouble(file.path)) {
        const added = countMatches(lines.added, ROUTE_LINE);
        const removed = countMatches(lines.removed, ROUTE_LINE);
        routes.added += added;
        routes.removed += removed;
        add("routes", file.path, added + removed);
        add("concurrency", file.path, countMatches(lines.added, CONCURRENCY));
      }
    }
  }
  if (snapshots.length >= BULK_SNAPSHOT_FILES)
    for (const path of snapshots) add("tests_weakened", path);

  const skimmable = skim.moved + skim.followsMove + skim.generated;
  const details = new Map<BriefSignalKind, string | undefined>([
    [
      "routes",
      joinParts([
        [routes.added, "added"],
        [routes.removed, "removed"],
      ]),
    ],
    [
      "dependencies",
      (tallies.get("dependencies")?.count ?? 0) > 0 && lockfilesOnly
        ? "lockfile only"
        : undefined,
    ],
    [
      "tests_weakened",
      joinParts([
        [
          weakened.deleted,
          weakened.deleted === 1 ? "file deleted" : "files deleted",
        ],
        [
          weakened.assertions,
          weakened.assertions === 1
            ? "assertion removed"
            : "assertions removed",
        ],
        [weakened.skipped, "skipped or focused"],
        [
          snapshots.length >= BULK_SNAPSHOT_FILES ? snapshots.length : 0,
          "snapshots updated",
        ],
      ]),
    ],
    [
      "tests_added",
      joinParts([
        [newTestFiles, newTestFiles === 1 ? "new file" : "new files"],
      ]),
    ],
    [
      "skimmable",
      skimmable === files.length && skimmable > 0
        ? "the whole change"
        : joinParts([
            [skim.moved, "moved"],
            [skim.followsMove, "follow the move"],
            [skim.generated, "generated"],
          ]),
    ],
  ]);
  tallies.set("skimmable", { count: skimmable, paths: [] });

  return BRIEF_SIGNAL_KINDS.map((kind) => {
    const tally = tallies.get(kind) ?? { count: 0, paths: [] };
    const detail = tally.count === 0 ? undefined : details.get(kind);
    return {
      kind,
      count: tally.count,
      paths: tally.paths.slice(0, MAX_SIGNAL_PATHS),
      ...definedProps({ detail }),
    };
  });
}

function areas(
  path: string,
  name: string,
  bucket: ChangeScopeBucket,
): ReadonlyArray<BriefSignalKind> {
  const directories = path.split("/").slice(0, -1);
  const source = bucket === "core" || name.endsWith(".proto");
  const kinds: Array<BriefSignalKind> = [];
  if (
    /^src\/index\.[^/]+$/.test(path) ||
    name.endsWith(".d.ts") ||
    name.startsWith("openapi") ||
    (source &&
      (directories.some((segment) =>
        /^(?:api|proto|cmd|bin|cli)$/.test(segment),
      ) ||
        (directories.includes("pkg") &&
          directories.some((segment) => /^v\d+$/.test(segment)))))
  )
    kinds.push("public_api");
  if (
    directories.some((segment) =>
      /^(?:migrations?|migrate|prisma)$/.test(segment),
    ) ||
    name.endsWith(".sql") ||
    /^schema\./.test(name)
  )
    kinds.push("stored_data");
  if (
    path.startsWith(".github/workflows/") ||
    (bucket === "core" && SECURITY_WORDS.test(path))
  )
    kinds.push("security_boundary");
  if (MANIFESTS.has(name) || LOCKFILES.has(name)) kinds.push("dependencies");
  if (
    name.startsWith(".env") ||
    /^Dockerfile|^docker-compose|^Procfile$|\.tf$/.test(name) ||
    directories.some((segment) =>
      /^(?:k8s|helm|kubernetes|terraform|deploy)$/.test(segment),
    ) ||
    (directories.some((segment) =>
      /^(?:config|configs|settings)$/.test(segment),
    ) &&
      CONFIG_EXTENSIONS.test(name))
  )
    kinds.push("config_or_deploy");
  return kinds;
}

/** A generated or hand-written mock: its code patterns are the tool's, not the author's. */
function isTestDouble(path: string): boolean {
  return path
    .split("/")
    .slice(0, -1)
    .some((segment) => /^(?:mocks?|fakes?|stubs?)$/.test(segment));
}

function isSnapshot(path: string): boolean {
  return (
    path.endsWith(".snap") ||
    path.endsWith(".golden") ||
    /(?:^|\/)(?:__snapshots__|golden)\//.test(path)
  );
}

function countMatches(lines: ReadonlyArray<string>, pattern: RegExp): number {
  return lines.filter((line) => pattern.test(line)).length;
}

/** `"2 added · 1 removed"`, leaving out the zero parts. */
function joinParts(
  parts: ReadonlyArray<readonly [number, string]>,
): string | undefined {
  const shown = parts.flatMap(([count, label]) =>
    count > 0 ? [`${String(count)} ${label}`] : [],
  );
  return shown.length === 0 ? undefined : shown.join(" · ");
}

/** Each file's added and removed line text, keyed by its path in the patch. */
function changedText(patch: string): ReadonlyMap<string, FileText> {
  const text = new Map<string, FileText>();
  let current: FileText | undefined;
  for (const token of tokenizeUnifiedPatch(patch)) {
    if (token.kind === "file_header") {
      current = { added: [], removed: [] };
      // `diff --git a/x b/x` names a deleted file on both sides, so the new side is always set.
      const path = token.newPath ?? token.oldPath;
      if (path !== undefined) text.set(path, current);
    } else if (current === undefined) continue;
    else if (token.kind === "body" && token.marker === "added")
      current.added.push(token.text);
    else if (token.kind === "body" && token.marker === "removed")
      current.removed.push(token.text);
  }
  return text;
}
