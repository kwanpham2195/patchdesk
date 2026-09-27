import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { ReviewSessionStore } from "../../src/adapters/storage/review-session-store";
import {
  parseLocalBranchName,
  parseReviewSessionId,
  type LocalBranchName,
} from "../../src/domain/ids";
import {
  isPullRequestReviewSession,
  type LocalReviewSession,
} from "../../src/domain/review-session";
import type { LocalReviewSourceRequest } from "../../src/domain/review-source";
import {
  git,
  profileId,
  value,
  type LocalApplyHarness,
} from "./local-apply-fixture";

export const main = value(parseLocalBranchName("main"));

/** The shared Review of the checked-out branch against `baseBranch`, `main` by default. */
export function shared(
  baseBranch: LocalBranchName = main,
): LocalReviewSourceRequest {
  return { kind: "local_branch", baseBranch };
}

/** The stored local session `sessionId` of the harness profile. */
export async function loadSession(
  harness: LocalApplyHarness,
  sessionId: string,
): Promise<LocalReviewSession> {
  const session = value(
    await new ReviewSessionStore(harness.paths).load(
      profileId,
      value(parseReviewSessionId(sessionId)),
    ),
  );
  if (isPullRequestReviewSession(session))
    throw new Error("Expected a local session");
  return session;
}

/** The checkout's index file as bytes; run `git status` first, since it refreshes the index. */
export function indexBytes(repositoryPath: string): Promise<Buffer> {
  return readFile(join(repositoryPath, ".git", "index"));
}

/** Each stored view patch's text and touched paths, read as a view switch would: from the session's files. */
export async function readViewPatches(session: LocalReviewSession) {
  const views = session.viewPatches;
  if (views === undefined) throw new Error("Expected view patches");
  const read = async (view: keyof typeof views) => ({
    text: await readFile(views[view].patchPath, "utf8"),
    paths: views[view].paths,
  });
  return {
    combined: await read("combined"),
    committed: await read("committed"),
    uncommitted: await read("uncommitted"),
  };
}

/**
 * Branch `feature` off `main` with one commit, `main` moved on past the fork,
 * and on `feature` a staged edit, an unstaged edit, and an untracked file.
 */
export async function featureWithCheckoutChanges(
  harness: LocalApplyHarness,
): Promise<void> {
  const { repositoryPath } = harness;
  git(repositoryPath, "checkout", "-q", "-b", "feature");
  await writeFile(join(repositoryPath, "feature.txt"), "committed\n");
  git(repositoryPath, "add", "feature.txt");
  git(repositoryPath, "commit", "-q", "-m", "feature");
  git(repositoryPath, "checkout", "-q", "main");
  await writeFile(join(repositoryPath, "main-only.txt"), "main\n");
  git(repositoryPath, "add", "main-only.txt");
  git(repositoryPath, "commit", "-q", "-m", "main moves on");
  git(repositoryPath, "checkout", "-q", "feature");
  await writeFile(join(repositoryPath, "tracked.txt"), "staged\n");
  git(repositoryPath, "add", "tracked.txt");
  await writeFile(join(repositoryPath, "feature.txt"), "committed\nunstaged\n");
  await writeFile(join(repositoryPath, "untracked.txt"), "untracked\n");
}
