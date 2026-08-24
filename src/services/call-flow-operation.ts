import { execFileSync, spawnSync } from "node:child_process";
import { extname } from "node:path";

import { runDiff, type DiffNode, type DiffResult } from "calldiff";
import * as v from "valibot";

import type {
  CallFlowLanguageSummary,
  CallFlowNode,
  CallFlowOutcome,
  CallFlowSnapshot,
  CallFlowTree,
} from "../domain/call-flow";
import { CALL_FLOW_LANGUAGE_NAMES } from "../domain/call-flow";

const MAX_SOURCE_FILES = 2_500;

const MAX_TREES = 100;
const MAX_NODES = 5_000;
const MAX_ASCII_BYTES = 750_000;
const GIT_OUTPUT_BYTES = 16 * 1024 * 1024;

const invocationSchema = v.strictObject({
  sessionId: v.pipe(v.string(), v.minLength(1), v.maxLength(256)),
  worktreePath: v.pipe(v.string(), v.minLength(1), v.maxLength(4_096)),
  baseSha: v.pipe(v.string(), v.regex(/^[a-f0-9]{40}$/)),
  headSha: v.pipe(v.string(), v.regex(/^[a-f0-9]{40}$/)),
});

const repoRelativePathSchema = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(1_024),
  v.regex(/^[^\\/]/),
  v.regex(/^(?!\.\.?([\\/]|$))/),
  v.regex(/^(?!.*[\\/]\.\.?([\\/]|$))/),
  v.regex(/^(?![A-Za-z]:[\\/])/),
);
const nodeSchema: v.GenericSchema<CallFlowNode> = v.lazy(() =>
  v.strictObject({
    key: v.pipe(v.string(), v.minLength(1), v.maxLength(1_024)),
    label: v.pipe(v.string(), v.minLength(1), v.maxLength(4_096)),
    status: v.picklist(["same", "added", "removed"]),
    kind: v.optional(v.picklist(["call", "branch"])),
    file: v.optional(repoRelativePathSchema),
    line: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
    endLine: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
    children: v.pipe(v.array(nodeSchema), v.maxLength(MAX_NODES)),
  }),
);
const snapshotSchema = v.strictObject({
  sessionId: v.pipe(v.string(), v.minLength(1), v.maxLength(256)),
  baseSha: v.pipe(v.string(), v.regex(/^[a-f0-9]{40}$/)),
  headSha: v.pipe(v.string(), v.regex(/^[a-f0-9]{40}$/)),
});
const languagesSchema = v.strictObject({
  analyzed: v.array(v.picklist(CALL_FLOW_LANGUAGE_NAMES)),
  available: v.literal(CALL_FLOW_LANGUAGE_NAMES.length),
  skippedChangedFiles: v.pipe(v.number(), v.integer(), v.minValue(0)),
});
const outcomeSchema: v.GenericSchema<CallFlowOutcome> = v.variant("state", [
  v.strictObject({
    state: v.literal("ready"),
    snapshot: snapshotSchema,
    trees: v.pipe(
      v.array(
        v.strictObject({
          entry: v.pipe(v.string(), v.minLength(1), v.maxLength(1_024)),
          ascii: v.pipe(v.string(), v.maxLength(MAX_ASCII_BYTES + 100)),
          tree: nodeSchema,
        }),
      ),
      v.maxLength(MAX_TREES),
    ),
    ascii: v.pipe(v.string(), v.maxLength(MAX_ASCII_BYTES + 100)),
    changedSteps: v.pipe(v.number(), v.integer(), v.minValue(0)),
    contextSteps: v.pipe(v.number(), v.integer(), v.minValue(0)),
    impactedFiles: v.pipe(v.number(), v.integer(), v.minValue(0)),
    languages: languagesSchema,
    truncated: v.boolean(),
  }),
  v.strictObject({
    state: v.literal("unsupported"),
    snapshot: snapshotSchema,
    languages: languagesSchema,
  }),
  v.strictObject({
    state: v.literal("unavailable"),
    reason: v.picklist([
      "metadata_only",
      "runtime_unavailable",
      "timed_out",
      "execution_failed",
      "too_large",
      "cancelled",
    ]),
  }),
]);

export type CallFlowInvocation = v.InferOutput<typeof invocationSchema>;

export function parseCallFlowInvocation(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- this function is the child process stdin boundary parser.
  input: unknown,
): CallFlowInvocation | undefined {
  const parsed = v.safeParse(invocationSchema, input);
  return parsed.success ? parsed.output : undefined;
}

export function parseCallFlowOutcome(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- this function is the child stdout boundary parser.
  input: unknown,
): CallFlowOutcome | undefined {
  const parsed = v.safeParse(outcomeSchema, input);
  return parsed.success ? parsed.output : undefined;
}

type CallDiffOptions = {
  readonly cwd: string;
  readonly from: string;
  readonly to: string;
  readonly paths: ReadonlyArray<string>;
  readonly maxDepth: number;
  readonly color: false;
  readonly locs: true;
};

type CallDiffEngine = (options: CallDiffOptions) => DiffResult;

/** Runs CallDiff against one immutable Review session and projects bounded renderer data. */
export function analyzeCallFlow(
  input: CallFlowInvocation,
  engine: CallDiffEngine = runDiff,
): CallFlowOutcome {
  const snapshot: CallFlowSnapshot = {
    sessionId: input.sessionId,
    baseSha: input.baseSha,
    headSha: input.headSha,
  };
  const packagedSourceFiles = listRevisionFiles(
    input.worktreePath,
    input.baseSha,
    input.headSha,
  ).filter(isPackagedSourceFile);
  const changedFiles = listChangedFiles(
    input.worktreePath,
    input.baseSha,
    input.headSha,
  );
  if (packagedSourceFiles.length > MAX_SOURCE_FILES) {
    return { state: "unavailable", reason: "too_large" };
  }
  const generatedGoFiles = standardGeneratedGoFiles(
    input.worktreePath,
    input.baseSha,
    input.headSha,
    packagedSourceFiles.filter((path) => extname(path) === ".go"),
  );
  const sourceFiles = packagedSourceFiles.filter(
    (path) => !generatedGoFiles.has(path),
  );
  const languages = languageSummary(
    sourceFiles,
    changedFiles,
    generatedGoFiles,
  );
  if (
    !changedFiles.some(
      (path) => isPackagedSourceFile(path) && !generatedGoFiles.has(path),
    )
  ) {
    return { state: "unsupported", snapshot, languages };
  }
  const result = engine({
    cwd: input.worktreePath,
    from: input.baseSha,
    to: input.headSha,
    paths: sourceFiles,
    maxDepth: 12,
    color: false,
    locs: true,
  });
  const projected = projectTrees(result);
  const impactedFiles = new Set<string>();
  let changedSteps = 0;
  let contextSteps = 0;
  for (const entry of projected.trees) {
    visitNode(entry.tree, (node) => {
      if (node.file !== undefined) impactedFiles.add(node.file);
      if (node.status === "same") contextSteps += 1;
      else changedSteps += 1;
    });
  }
  return {
    state: "ready",
    snapshot,
    trees: projected.trees,
    ascii: projected.ascii,
    changedSteps,
    contextSteps,
    impactedFiles: impactedFiles.size,
    languages,
    truncated: projected.truncated,
  };
}

function listRevisionFiles(
  cwd: string,
  baseSha: string,
  headSha: string,
): ReadonlyArray<string> {
  return unique([
    ...gitLines(cwd, ["ls-tree", "-r", "--name-only", baseSha]),
    ...gitLines(cwd, ["ls-tree", "-r", "--name-only", headSha]),
  ]);
}

function listChangedFiles(
  cwd: string,
  baseSha: string,
  headSha: string,
): ReadonlyArray<string> {
  return gitLines(cwd, ["diff", "--name-only", baseSha, headSha]);
}

function gitLines(
  cwd: string,
  args: ReadonlyArray<string>,
): ReadonlyArray<string> {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: GIT_OUTPUT_BYTES,
    stdio: ["ignore", "pipe", "pipe"],
  })
    .split("\n")
    .filter((line) => line.length > 0);
}

const packagedExtensions = new Set([
  ".cjs",
  ".cts",
  ".go",
  ".js",
  ".jsx",
  ".mjs",
  ".mts",
  ".ts",
  ".tsx",
]);

function isPackagedSourceFile(path: string): boolean {
  return !path.endsWith(".d.ts") && packagedExtensions.has(extname(path));
}

function standardGeneratedGoFiles(
  cwd: string,
  baseSha: string,
  headSha: string,
  paths: ReadonlyArray<string>,
): ReadonlySet<string> {
  const generated = new Set<string>();
  const sourcePaths = new Set(paths);
  const markerCandidates = new Set([
    ...generatedMarkerFiles(cwd, baseSha),
    ...generatedMarkerFiles(cwd, headSha),
  ]);
  for (const path of markerCandidates) {
    if (!sourcePaths.has(path) || generated.has(path)) continue;
    for (const revision of [baseSha, headSha]) {
      const source = readRevisionFile(cwd, revision, path);
      if (source === undefined) continue;
      const packageOffset = source.search(/^package\s+/m);
      const leading =
        packageOffset < 0 ? source : source.slice(0, packageOffset);
      if (/^\/\/ Code generated .* DO NOT EDIT\.$/m.test(leading)) {
        generated.add(path);
        break;
      }
    }
  }
  return generated;
}

function generatedMarkerFiles(
  cwd: string,
  revision: string,
): ReadonlyArray<string> {
  const result = spawnSync(
    "git",
    [
      "grep",
      "-l",
      "-I",
      "-E",
      "^// Code generated .* DO NOT EDIT\\.$",
      revision,
      "--",
      "*.go",
    ],
    {
      cwd,
      encoding: "utf8",
      maxBuffer: GIT_OUTPUT_BYTES,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(result.stderr || "Unable to inspect generated Go files");
  }
  if (result.status === 1) return [];
  const prefix = `${revision}:`;
  return result.stdout
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) =>
      line.startsWith(prefix) ? line.slice(prefix.length) : line,
    );
}

function readRevisionFile(
  cwd: string,
  revision: string,
  path: string,
): string | undefined {
  if (
    !gitLines(cwd, ["ls-tree", "--name-only", revision, "--", path]).includes(
      path,
    )
  ) {
    return undefined;
  }
  return execFileSync("git", ["show", `${revision}:${path}`], {
    cwd,
    encoding: "utf8",
    maxBuffer: GIT_OUTPUT_BYTES,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function languageSummary(
  sourceFiles: ReadonlyArray<string>,
  changedFiles: ReadonlyArray<string>,
  generatedGoFiles: ReadonlySet<string>,
): CallFlowLanguageSummary {
  const analyzed = new Set<CallFlowLanguageSummary["analyzed"][number]>();
  for (const path of sourceFiles) {
    const extension = extname(path);
    if (extension === ".go") analyzed.add("Go");
    else if (extension === ".tsx") analyzed.add("TSX");
    else if (extension === ".jsx") analyzed.add("JSX");
    else if ([".ts", ".mts", ".cts"].includes(extension))
      analyzed.add("TypeScript");
    else analyzed.add("JavaScript");
  }
  return {
    analyzed: [...analyzed].sort(),
    available: CALL_FLOW_LANGUAGE_NAMES.length,
    skippedChangedFiles: changedFiles.filter(
      (path) => !isPackagedSourceFile(path) || generatedGoFiles.has(path),
    ).length,
  };
}

type ProjectedTrees = {
  readonly trees: ReadonlyArray<CallFlowTree>;
  readonly ascii: string;
  readonly truncated: boolean;
};
type ProjectedNode = {
  readonly node: CallFlowNode;
  readonly truncated: boolean;
};
type MutableCallFlowNode = {
  key: string;
  label: string;
  status: CallFlowNode["status"];
  kind?: CallFlowNode["kind"];
  file?: string;
  line?: number;
  endLine?: number;
  children: ReadonlyArray<CallFlowNode>;
};

function projectTrees(result: DiffResult): ProjectedTrees {
  let remainingNodes = MAX_NODES;
  let truncated = result.trees.length > MAX_TREES;
  const trees: Array<CallFlowTree> = [];
  for (const entry of result.trees.slice(0, MAX_TREES)) {
    if (remainingNodes <= 0) {
      truncated = true;
      break;
    }
    const projected = projectNode(entry.tree, () => {
      remainingNodes -= 1;
      return remainingNodes >= 0;
    });
    if (projected.truncated) truncated = true;
    trees.push({
      entry: entry.entry,
      ascii: entry.ascii,
      tree: projected.node,
    });
  }
  const asciiSource = trees.map((tree) => tree.ascii).join("\n\n");
  const ascii = boundUtf8(asciiSource, MAX_ASCII_BYTES);
  if (ascii.length !== asciiSource.length) truncated = true;
  return { trees, ascii, truncated };
}

function projectNode(node: DiffNode, reserve: () => boolean): ProjectedNode {
  let truncated = false;
  const children: Array<CallFlowNode> = [];
  for (const child of node.children) {
    if (!reserve()) {
      truncated = true;
      break;
    }
    const projected = projectNode(child, reserve);
    children.push(projected.node);
    if (projected.truncated) truncated = true;
  }
  const output: MutableCallFlowNode = {
    key: node.key,
    label: node.label,
    status: node.status,
    children,
  };
  if (node.kind !== undefined) output.kind = node.kind;
  if (node.file !== undefined) output.file = node.file;
  if (node.line !== undefined) output.line = node.line;
  if (node.endLine !== undefined) output.endLine = node.endLine;
  return { node: output, truncated };
}

function visitNode(
  node: CallFlowNode,
  visit: (node: CallFlowNode) => void,
): void {
  visit(node);
  for (const child of node.children) visitNode(child, visit);
}

function unique(values: ReadonlyArray<string>): ReadonlyArray<string> {
  return [...new Set(values)].sort();
}

function boundUtf8(value: string, bytes: number): string {
  const buffer = Buffer.from(value, "utf8");
  return buffer.byteLength <= bytes
    ? value
    : `${buffer.subarray(0, bytes).toString("utf8")}\n\n… output truncated`;
}
