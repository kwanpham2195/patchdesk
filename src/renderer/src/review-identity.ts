import {
  createReviewId,
  parseGitHubHost,
  parseGitHubOwner,
  parseGitHubRepoName,
  parsePullRequestNumber,
  parseWorkspaceProfileId,
} from "../../domain/ids";

/** Derives the stable Review key for older in-memory projections that omit it. */
export function reviewIdForSession(input: {
  readonly profileId?: unknown;
  readonly host?: unknown;
  readonly owner?: unknown;
  readonly repo?: unknown;
  readonly prNumber?: unknown;
}): string | undefined {
  const profileId = parseWorkspaceProfileId(input.profileId);
  const host = parseGitHubHost(input.host);
  const owner = parseGitHubOwner(input.owner);
  const repo = parseGitHubRepoName(input.repo);
  const prNumber = parsePullRequestNumber(input.prNumber);
  if (profileId._tag === "err" || host._tag === "err" || owner._tag === "err" || repo._tag === "err" || prNumber._tag === "err") return undefined;
  return createReviewId({ profileId: profileId.value, host: host.value, owner: owner.value, repo: repo.value, prNumber: prNumber.value });
}
