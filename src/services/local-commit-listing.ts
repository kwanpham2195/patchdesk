import { maxPullRequestCommits } from "../adapters/github/github-graphql-queries";
import type { PullRequestCommit } from "../domain/github-context";
import { parseGitSha, parseIsoTimestamp, type GitSha } from "../domain/ids";
import type {
  LocalCommit,
  LocalSessionCommits,
} from "../domain/review-session";
import type { GitReadExecutor } from "./review-worktree-service";

/**
 * The commits in `baseSha..checkoutHeadSha`, newest first in topological
 * order, capped like a pull request's list (#557 D2, D3). Git runs in
 * `worktreePath`, the session's worktree, so the listing reads objects and
 * never the maintainer's checkout. Undefined when git fails or reports a
 * commit it cannot describe.
 */
export async function listLocalCommits(
  git: GitReadExecutor,
  worktreePath: string,
  baseSha: GitSha,
  checkoutHeadSha: GitSha,
): Promise<LocalSessionCommits | undefined> {
  const range = `${baseSha}..${checkoutHeadSha}`;
  const counted = await git.run([
    "git",
    "-C",
    worktreePath,
    "rev-list",
    "--count",
    "--end-of-options",
    range,
  ]);
  if (counted._tag === "err") return undefined;
  const total = Number(counted.value.stdout.trim());
  if (!Number.isSafeInteger(total) || total < 0) return undefined;
  // `rev-list` rather than `log`: no `log.*` setting can add lines to the output.
  const listed = await git.run([
    "git",
    "-C",
    worktreePath,
    "rev-list",
    "--topo-order",
    `--max-count=${String(maxPullRequestCommits)}`,
    "--no-commit-header",
    "--format=%H%x00%an%x00%at%x00%s",
    "--end-of-options",
    range,
  ]);
  if (listed._tag === "err") return undefined;
  const newest: LocalCommit[] = [];
  for (const line of listed.value.stdout.split("\n")) {
    if (line === "") continue;
    const commit = parseListedCommit(line);
    if (commit === undefined) return undefined;
    newest.push(commit);
  }
  return { newest, total };
}

function parseListedCommit(line: string): LocalCommit | undefined {
  const [sha, authorName, authorSeconds, subject] = line.split("\0");
  const parsedSha = parseGitSha(sha);
  const seconds = Number(authorSeconds);
  if (
    parsedSha._tag === "err" ||
    authorName === undefined ||
    subject === undefined ||
    authorSeconds === "" ||
    !Number.isSafeInteger(seconds)
  )
    return undefined;
  const authoredAt = parseIsoTimestamp(new Date(seconds * 1000).toISOString());
  return authoredAt._tag === "ok"
    ? {
        sha: parsedSha.value,
        subject,
        authorName,
        authoredAt: authoredAt.value,
      }
    : undefined;
}

/** A stored local commit in the shape the navigator and the commit slice share with a pull request. */
export function asPullRequestCommit(
  commit: LocalCommit,
  checkoutHeadSha: GitSha | undefined,
): PullRequestCommit {
  return {
    sha: commit.sha,
    message: commit.subject,
    author: commit.authorName,
    authoredAt: commit.authoredAt,
    isHead: commit.sha === checkoutHeadSha,
  };
}

/**
 * What `commitSha` is compared with: its first parent, or for a root commit
 * the empty tree, whose ID `hash-object` computes without writing an object.
 */
export async function readFirstParentOrEmptyTree(
  git: GitReadExecutor,
  repositoryPath: string,
  commitSha: GitSha,
): Promise<GitSha | undefined> {
  const parents = await git.run([
    "git",
    "-C",
    repositoryPath,
    "rev-list",
    "--parents",
    "-n",
    "1",
    "--end-of-options",
    commitSha,
  ]);
  if (parents._tag === "err") return undefined;
  const firstParent = parents.value.stdout.trim().split(" ")[1];
  if (firstParent !== undefined) return parseGitShaOrUndefined(firstParent);
  const emptyTree = await git.run([
    "git",
    "-C",
    repositoryPath,
    "hash-object",
    "-t",
    "tree",
    "/dev/null",
  ]);
  return emptyTree._tag === "ok"
    ? parseGitShaOrUndefined(emptyTree.value.stdout.trim())
    : undefined;
}

function parseGitShaOrUndefined(value: string): GitSha | undefined {
  const parsed = parseGitSha(value);
  return parsed._tag === "ok" ? parsed.value : undefined;
}
