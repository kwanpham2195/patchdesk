import * as v from "valibot";

import { parseUnifiedPatch } from "./patch";

/**
 * The Scope gauge's buckets, in the order the gauge draws them. A path lands
 * in exactly one bucket; `classifyChangedPath` evaluates the rules in the
 * order `generated, tests, docs, config, core` regardless of this order.
 */
const CHANGE_SCOPE_BUCKETS = [
  "core",
  "tests",
  "generated",
  "docs",
  "config",
] as const;

export type ChangeScopeBucket = (typeof CHANGE_SCOPE_BUCKETS)[number];

type ChangeScopeTotals = {
  readonly files: number;
  readonly additions: number;
  readonly deletions: number;
};

/** Deterministic per-bucket line counts for one changed file set. Buckets with no file are omitted. */
export type ChangeScope = {
  readonly buckets: ReadonlyArray<
    { readonly bucket: ChangeScopeBucket } & ChangeScopeTotals
  >;
  readonly total: ChangeScopeTotals;
};

export type ChangeScopeFile = {
  readonly path: string;
  readonly additions: number;
  readonly deletions: number;
  /**
   * The file's leading bytes when they are reachable, so the generated-banner
   * rule can run. Patchdesk classifies from a unified patch, which carries no
   * file contents, so this is normally absent and the path rules alone decide.
   */
  readonly head?: string;
};

export type ChangeScopeOptions = {
  /**
   * Repository-relative paths `.gitattributes` marks `linguist-generated`.
   * Absent whenever no worktree was read; the default path rules below then
   * decide the `generated` bucket on their own.
   */
  readonly generatedPaths?: ReadonlyArray<string>;
};

/** Lockfiles no reviewer reads line by line; matched on the file name alone. */
const LOCKFILE_NAMES: ReadonlyArray<string> = [
  "pnpm-lock.yaml",
  "package-lock.json",
  "yarn.lock",
  "Cargo.lock",
  "go.sum",
];

const TEST_DIRECTORY_SEGMENTS: ReadonlyArray<string> = [
  "tests",
  "test",
  "__tests__",
  "e2e",
  "fixtures",
];

/**
 * Test file-name conventions, one row per ecosystem, matched against the file
 * name alone. The JavaScript family marks a test with an infix (`a.test.ts`);
 * every other row is a suffix convention that infix rule misses, which is what
 * put a Go `refresh_cache_test.go` or a JUnit `RepositoryTest.java` in `core`.
 */
const TEST_FILE_NAME_RULES: ReadonlyArray<{
  readonly convention: string;
  readonly matches: RegExp;
}> = [
  {
    convention: "JavaScript, TypeScript: a.test.ts, a.spec.tsx",
    matches: /\.(?:test|spec)\./,
  },
  {
    convention: "Go, Rust, C, C++: a_test.go, a_test.rs",
    matches: /_test\.(?:go|rs|c|cc|cpp|cxx|h|hpp)$/,
  },
  {
    convention: "Python: test_a.py, a_test.py",
    matches: /^test_.+\.py$|_test\.py$/,
  },
  {
    convention: "Java, Kotlin, C#, PHP, Swift, Scala: ATest.java, ATests.cs",
    matches: /Tests?\.(?:java|kt|kts|cs|php|swift|scala)$/,
  },
  { convention: "Ruby: a_spec.rb, a_test.rb", matches: /_(?:spec|test)\.rb$/ },
  { convention: "Elixir: a_test.exs", matches: /_test\.exs$/ },
];

const CONFIG_DATA_EXTENSIONS: ReadonlyArray<string> = [
  ".json",
  ".yaml",
  ".yml",
  ".toml",
];

/** How many leading lines the generated-banner rule reads when contents are reachable. */
const GENERATED_BANNER_LINES = 3;

/**
 * The one bucket a changed path belongs to. Rules are evaluated in the order
 * `generated, tests, docs, config, core`, so a generated snapshot under
 * `tests/` reads as generated and a Markdown file under `docs/` never reaches
 * the config rule.
 */
export function classifyChangedPath(
  file: ChangeScopeFile,
  options: ChangeScopeOptions = {},
): ChangeScopeBucket {
  const path = normalizeChangedPath(file.path);
  const segments = path.split("/");
  const name = segments.at(-1) ?? path;
  if (isGenerated(path, segments, name, file.head, options)) return "generated";
  if (isTests(segments, name)) return "tests";
  if (isDocs(segments, name)) return "docs";
  if (isConfig(path, segments, name)) return "config";
  return "core";
}

/** The smallest share of the Scope gauge's bar a non-empty bucket may occupy, in percent. */
const MIN_SEGMENT_PERCENT = 2;

/**
 * The Scope gauge's segment widths, in percent of the bar and summing to 100.
 * A bucket that changed at least one line keeps a `MIN_SEGMENT_PERCENT`
 * sliver, so a one-line config change beside a thousand-line lockfile does
 * not vanish; the rest is shared out in proportion, so the floor never pushes
 * the bar past its track.
 */
export function changeScopeSegments(scope: ChangeScope): ReadonlyArray<{
  readonly bucket: ChangeScopeBucket;
  readonly percent: number;
}> {
  const changedLines = scope.buckets.map(
    (bucket) => bucket.additions + bucket.deletions,
  );
  const total = changedLines.reduce((running, lines) => running + lines, 0);
  const shareable = Math.max(
    0,
    100 - MIN_SEGMENT_PERCENT * scope.buckets.length,
  );
  return scope.buckets.map((bucket, index) => ({
    bucket: bucket.bucket,
    percent:
      total === 0
        ? 100 / scope.buckets.length
        : MIN_SEGMENT_PERCENT +
          ((changedLines[index] ?? 0) / total) * shareable,
  }));
}

/** Sums one changed file set into its buckets; the returned buckets keep `CHANGE_SCOPE_BUCKETS` order. */
export function computeChangeScope(
  files: ReadonlyArray<ChangeScopeFile>,
  options: ChangeScopeOptions = {},
): ChangeScope {
  const totals = new Map<ChangeScopeBucket, ChangeScopeTotals>();
  for (const file of files) {
    const bucket = classifyChangedPath(file, options);
    const running = totals.get(bucket);
    totals.set(bucket, {
      files: (running?.files ?? 0) + 1,
      additions: (running?.additions ?? 0) + file.additions,
      deletions: (running?.deletions ?? 0) + file.deletions,
    });
  }
  const buckets = CHANGE_SCOPE_BUCKETS.flatMap((bucket) => {
    const bucketTotals = totals.get(bucket);
    return bucketTotals === undefined ? [] : [{ bucket, ...bucketTotals }];
  });
  return {
    buckets,
    total: buckets.reduce<ChangeScopeTotals>(
      (running, entry) => ({
        files: running.files + entry.files,
        additions: running.additions + entry.additions,
        deletions: running.deletions + entry.deletions,
      }),
      { files: 0, additions: 0, deletions: 0 },
    ),
  };
}

/**
 * The Scope gauge for one stored unified patch. A patch carries no file
 * contents, so the generated-banner rule never fires here and the path rules
 * decide on their own.
 */
export function changeScopeFromPatch(
  patch: string,
  options: ChangeScopeOptions = {},
): ChangeScope {
  return computeChangeScope(
    parseUnifiedPatch(patch).map((file) => ({
      path:
        file.newPath.length === 0 || file.newPath === "/dev/null"
          ? file.oldPath
          : file.newPath,
      additions: file.additions,
      deletions: file.deletions,
    })),
    options,
  );
}

const totalsSchema = v.strictObject({
  files: v.pipe(v.number(), v.integer(), v.minValue(0)),
  additions: v.pipe(v.number(), v.integer(), v.minValue(0)),
  deletions: v.pipe(v.number(), v.integer(), v.minValue(0)),
});

/** The renderer-side parser for a `ChangeScope` crossing the local API's JSON boundary. */
export const changeScopeSchema = v.strictObject({
  buckets: v.array(
    v.strictObject({
      bucket: v.picklist(CHANGE_SCOPE_BUCKETS),
      ...totalsSchema.entries,
    }),
  ),
  total: totalsSchema,
});

/** Windows-style separators reach Patchdesk only through hand-written input; the rules read `/`. */
function normalizeChangedPath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//, "");
}

function isGenerated(
  path: string,
  segments: ReadonlyArray<string>,
  name: string,
  head: string | undefined,
  options: ChangeScopeOptions,
): boolean {
  if (options.generatedPaths?.includes(path) === true) return true;
  if (LOCKFILE_NAMES.includes(name)) return true;
  if (/\.generated\./.test(name)) return true;
  if (segments.includes("__snapshots__")) return true;
  if (name.endsWith(".snap")) return true;
  if (name.startsWith("api-report") && name.endsWith(".md")) return true;
  return head !== undefined && hasGeneratedBanner(head);
}

function hasGeneratedBanner(head: string): boolean {
  const banner = head.split("\n").slice(0, GENERATED_BANNER_LINES).join("\n");
  return banner.includes("DO NOT EDIT") || banner.includes("@generated");
}

function isTests(segments: ReadonlyArray<string>, name: string): boolean {
  if (segments.slice(0, -1).some((segment) => isTestSegment(segment)))
    return true;
  return TEST_FILE_NAME_RULES.some((rule) => rule.matches.test(name));
}

function isTestSegment(segment: string): boolean {
  return TEST_DIRECTORY_SEGMENTS.includes(segment);
}

function isDocs(segments: ReadonlyArray<string>, name: string): boolean {
  if (segments.slice(0, -1).includes("docs")) return true;
  if (name.endsWith(".md") || name.endsWith(".mdx")) return true;
  return name.startsWith("CHANGELOG") || name.startsWith("LICENSE");
}

function isConfig(
  path: string,
  segments: ReadonlyArray<string>,
  name: string,
): boolean {
  if (segments.length === 1 && name.startsWith(".")) return true;
  const directories = segments.slice(0, -1);
  if (directories.includes(".github") || directories.includes("scripts"))
    return true;
  if (name.startsWith("tsconfig") && name.endsWith(".json")) return true;
  if (/\.config\./.test(name)) return true;
  return (
    !path.startsWith("src/") &&
    CONFIG_DATA_EXTENSIONS.some((extension) => name.endsWith(extension))
  );
}
