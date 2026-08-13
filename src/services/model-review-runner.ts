import { readFile } from "node:fs/promises";
import { isAbsolute, win32 } from "node:path";

import { ReviewInspector } from "./review-inspector";
import { composeReviewPrompt } from "./review-rubric";

const MAX_SNAPSHOT_FILE_BYTES = 512 * 1024;
const MAX_SNAPSHOT_TOTAL_BYTES = 4 * 1024 * 1024;
const GIT_SHA = /^[a-f0-9]{40,64}$/;

export type PreparedModelReview = {
  readonly prompt: string;
  readonly inspector: ReviewInspector;
};

type PrepareModelReviewInput = {
  readonly worktreePath: string;
  readonly contextPath: string;
  readonly reviewInputPath: string;
  readonly patchPath: string;
  readonly debugPath: string;
  readonly gitShow: (argv: ReadonlyArray<string>) => Promise<string>;
};

/** Prepares one immutable Analysis prompt and its invocation-scoped inspector. */
export async function prepareModelReview(
  input: PrepareModelReviewInput,
): Promise<PreparedModelReview> {
  const [context, reviewInput, fullPatch] = await Promise.all([
    readFile(input.contextPath, "utf8"),
    readFile(input.reviewInputPath, "utf8"),
    readFile(input.patchPath, "utf8"),
  ]);
  const files = changedFiles(context);
  const headSha = reviewHeadSha(context);
  const fileSnapshots = await snapshotChangedFiles(
    input.worktreePath,
    headSha,
    files,
    input.gitShow,
  );
  const inspector = new ReviewInspector({
    worktreePath: input.worktreePath,
    changedFiles: files,
    fileSnapshots,
    debugPath: input.debugPath,
    allowedRevisions: headSha === undefined ? ["HEAD"] : ["HEAD", headSha],
    gitShow: input.gitShow,
  });
  return {
    prompt: composeReviewPrompt({ reviewInput, context, fullPatch }),
    inspector,
  };
}

async function snapshotChangedFiles(
  worktreePath: string,
  headSha: string | undefined,
  files: ReadonlyArray<string>,
  gitShow: (argv: ReadonlyArray<string>) => Promise<string>,
): Promise<Readonly<Record<string, string>>> {
  const snapshots: Record<string, string> = {};
  if (headSha === undefined) return snapshots;
  let snapshotBytes = 0;
  for (const path of files) {
    if (!isSafeRelativePath(path)) continue;
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
      if (!isRegularTreeEntry(mode)) continue;
      if ((await gitShow([...git, "cat-file", "-t", object])).trim() !== "blob")
        continue;
      const fileBytes = parseBlobByteLength(
        await gitShow([...git, "cat-file", "-s", object]),
      );
      if (fileBytes === undefined || fileBytes > MAX_SNAPSHOT_FILE_BYTES)
        continue;
      if (snapshotBytes + fileBytes > MAX_SNAPSHOT_TOTAL_BYTES) break;
      const contents = await gitShow([...git, "cat-file", "blob", object]);
      if (Buffer.byteLength(contents, "utf8") !== fileBytes) continue;
      snapshots[path] = contents;
      snapshotBytes += fileBytes;
    } catch {
      // Missing, binary, and unreadable blobs remain represented by the immutable patch.
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
function reviewHeadSha(context: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(context);
    const head =
      typeof parsed === "object" && parsed !== null
        ? (parsed as { pr?: { headSha?: unknown } }).pr?.headSha
        : undefined;
    return typeof head === "string" && GIT_SHA.test(head) ? head : undefined;
  } catch {
    return undefined;
  }
}
function changedFiles(context: string): ReadonlyArray<string> {
  try {
    const parsed: unknown = JSON.parse(context);
    const files =
      typeof parsed === "object" && parsed !== null
        ? (parsed as { changedFiles?: unknown }).changedFiles
        : undefined;
    return Array.isArray(files)
      ? files.filter((path): path is string => typeof path === "string")
      : [];
  } catch {
    return [];
  }
}
