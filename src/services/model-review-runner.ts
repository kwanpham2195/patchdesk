import { isAbsolute, win32 } from "node:path";

import * as v from "valibot";

import { ReviewInspector } from "./review-inspector";
import type { InsightLanguage } from "#src/domain/insight-provider";
import { composeReviewPrompt } from "./review-rubric";
import type { InsightEvidenceBundle } from "#src/domain/insight-evidence";
import { insightEvidenceReference } from "./insight-evidence-reference";

const MAX_SNAPSHOT_FILE_BYTES = 512 * 1024;
const MAX_SNAPSHOT_TOTAL_BYTES = 4 * 1024 * 1024;
/** Hard bound for one composed Analysis prompt; mirrors the child protocol prompt cap. */
const MAX_ANALYSIS_PROMPT_BYTES = 32_768;
/** Only the changed-file list; non-string entries are dropped, not rejected. */
const contextChangedFilesSchema = v.looseObject({
  changedFiles: v.pipe(
    v.array(v.unknown()),
    v.transform((entries) =>
      entries.flatMap((entry) => {
        const path = v.safeParse(v.string(), entry);
        return path.success ? [path.output] : [];
      }),
    ),
  ),
});

export type PreparedModelReview = {
  readonly prompt: string;
  readonly inspector: ReviewInspector;
};

/** Signals a composed Analysis prompt that exceeds the bounded model input. */
class AnalysisPromptTooLargeError extends Error {
  constructor() {
    super("Analysis prompt exceeds the bounded input size");
    this.name = "AnalysisPromptTooLargeError";
  }
}

type PrepareModelReviewInput = {
  readonly evidence: InsightEvidenceBundle;
  readonly worktreePath: string;
  readonly contextPath: string;
  readonly reviewInputPath: string;
  readonly patchPath: string;
  readonly debugPath: string;
  readonly language: InsightLanguage;
  readonly gitShow: (argv: ReadonlyArray<string>) => Promise<string>;
};

/** Prepares one immutable Analysis prompt and its invocation-scoped inspector. */
export async function prepareModelReview(
  input: PrepareModelReviewInput,
): Promise<PreparedModelReview> {
  const headSha = input.evidence.identity.headSha;
  const fileSnapshots: Record<string, string> = Object.create(null);
  if (input.evidence.tree === undefined)
    throw new Error("Analysis evidence must be re-prepared");
  const sources = new Map(
    input.evidence.sources.map((source) => [source.name, source]),
  );
  for (const snapshot of input.evidence.tree.snapshots) {
    const source = sources.get(snapshot.name);
    if (source === undefined)
      throw new Error("Captured snapshot source is missing");
    fileSnapshots[snapshot.path] = source.text;
  }
  const files = Object.keys(fileSnapshots);
  const inspector = new ReviewInspector({
    worktreePath: input.worktreePath,
    changedFiles: files,
    fileSnapshots,
    debugPath: input.debugPath,
    allowedRevisions: ["HEAD", headSha],
    capturedHeadSha: headSha,
    gitShow: input.gitShow,
  });
  const prompt = composeReviewPrompt({
    evidence: insightEvidenceReference(input.evidence),
    language: input.language,
  });
  if (Buffer.byteLength(prompt, "utf8") > MAX_ANALYSIS_PROMPT_BYTES)
    throw new AnalysisPromptTooLargeError();
  return {
    prompt,
    inspector,
  };
}

/** Captures bounded regular blobs by the supplied SHA, never current HEAD or live files. */
export async function captureModelReviewSnapshots(input: {
  readonly worktreePath: string;
  readonly headSha: string;
  readonly context: string;
  readonly onSkipped?: ((path: string, reason: string) => void) | undefined;
  readonly gitShow: (argv: ReadonlyArray<string>) => Promise<string>;
}): Promise<Readonly<Record<string, string>>> {
  return snapshotChangedFiles(
    input.worktreePath,
    input.headSha,
    changedFiles(input.context),
    input.gitShow,
    input.onSkipped,
  );
}

async function snapshotChangedFiles(
  worktreePath: string,
  headSha: string | undefined,
  files: ReadonlyArray<string>,
  gitShow: (argv: ReadonlyArray<string>) => Promise<string>,
  onSkipped?: (path: string, reason: string) => void,
): Promise<Readonly<Record<string, string>>> {
  const snapshots: Record<string, string> = Object.create(null);
  if (headSha === undefined) return snapshots;
  let snapshotBytes = 0;
  for (const [index, path] of files.entries()) {
    if (!isSafeRelativePath(path)) {
      onSkipped?.(path, "unrepresentable");
      continue;
    }
    try {
      const object = `${headSha}:${path}`;
      const git = ["git", "--no-replace-objects", "-C", worktreePath] as const;
      const mode = await gitShow([
        ...git,
        "ls-tree",
        "--format=%(objectmode)",
        headSha,
        "--",
        path,
      ]);
      if (!isRegularTreeEntry(mode)) {
        onSkipped?.(path, mode.trim() === "" ? "deleted" : "nonregular");
        continue;
      }
      if ((await gitShow([...git, "cat-file", "-t", object])).trim() !== "blob")
        continue;
      const fileBytes = parseBlobByteLength(
        await gitShow([...git, "cat-file", "-s", object]),
      );
      if (fileBytes === undefined || fileBytes > MAX_SNAPSHOT_FILE_BYTES) {
        onSkipped?.(path, "oversized");
        continue;
      }
      if (snapshotBytes + fileBytes > MAX_SNAPSHOT_TOTAL_BYTES) {
        for (const remaining of files.slice(index))
          onSkipped?.(remaining, "over_run_total");
        break;
      }
      const contents = await gitShow([...git, "cat-file", "blob", object]);
      if (
        Buffer.byteLength(contents, "utf8") !== fileBytes ||
        contents.includes("\0")
      ) {
        onSkipped?.(path, "binary");
        continue;
      }
      snapshots[path] = contents;
      snapshotBytes += fileBytes;
    } catch {
      onSkipped?.(path, "unavailable");
    }
  }
  return snapshots;
}

function isSafeRelativePath(path: string): boolean {
  return (
    path.length > 0 &&
    path !== "." &&
    !path.startsWith("./") &&
    !path.startsWith(".\\") &&
    !isAbsolute(path) &&
    !win32.isAbsolute(path) &&
    !/^[a-z]:/i.test(path) &&
    !path.includes("\0") &&
    !path.split(/[\\/]/).includes("..")
  );
}
function isRegularTreeEntry(raw: string): boolean {
  return ["100644", "100755"].includes(raw.trim());
}
function parseBlobByteLength(raw: string): number | undefined {
  const bytes = raw.trim();
  return /^(?:0|[1-9]\d*)$/.test(bytes) && Number.isSafeInteger(Number(bytes))
    ? Number(bytes)
    : undefined;
}
function changedFiles(context: string): ReadonlyArray<string> {
  try {
    const parsed = v.safeParse(contextChangedFilesSchema, JSON.parse(context));
    return parsed.success ? parsed.output.changedFiles : [];
  } catch {
    return [];
  }
}
