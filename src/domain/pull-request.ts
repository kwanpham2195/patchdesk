import * as v from "valibot";

import {
  parseGitHubHost,
  parseGitHubOwner,
  parseGitHubRepoName,
  parsePullRequestNumber,
  type GitHubHost,
  type GitHubOwner,
  type GitHubRepoName,
  type PullRequestNumber,
  type WorkspaceProfileId,
} from "./ids";
import { err, ok, type Result } from "./result";

export type PullRequestRef = {
  readonly host: GitHubHost;
  readonly owner: GitHubOwner;
  readonly repo: GitHubRepoName;
  readonly number: PullRequestNumber;
};

export type PullRequestInput =
  | { readonly _tag: "GitHubUrl"; readonly url: string }
  | { readonly _tag: "CompactRef"; readonly value: string }
  | {
      readonly _tag: "SelectedDashboardPr";
      readonly profileId: WorkspaceProfileId;
      readonly pr: PullRequestRef;
    }
  | {
      readonly _tag: "SeparateFields";
      readonly host?: GitHubHost;
      readonly owner: GitHubOwner;
      readonly repo: GitHubRepoName;
      readonly number: PullRequestNumber;
    };

export type InvalidPullRequestInput = {
  readonly _tag: "InvalidPullRequestInput";
};

/** Parse direct URL or compact owner/repo#number input at the UI boundary. */
export function parsePullRequestInput(
  input: unknown,
): Result<PullRequestRef, InvalidPullRequestInput> {
  if (typeof input !== "string") {
    return err({ _tag: "InvalidPullRequestInput" });
  }

  const urlMatch = /^https:\/\/([^/]+)\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?$/.exec(input);
  if (urlMatch !== null) {
    return parseReference(urlMatch[1], urlMatch[2], urlMatch[3], Number(urlMatch[4]));
  }

  const compactMatch = /^([^/]+)\/([^#]+)#(\d+)$/.exec(input);
  if (compactMatch !== null) {
    return parseReference("github.com", compactMatch[1], compactMatch[2], Number(compactMatch[3]));
  }

  return err({ _tag: "InvalidPullRequestInput" });
}

/** Valibot schema for a direct-entry request body before it enters a service. */
export const pullRequestInputSchema = v.strictObject({
  value: v.pipe(v.string(), v.minLength(1)),
});

function parseReference(
  hostInput: string | undefined,
  ownerInput: string | undefined,
  repoInput: string | undefined,
  numberInput: number,
): Result<PullRequestRef, InvalidPullRequestInput> {
  const host = parseGitHubHost(hostInput);
  const owner = parseGitHubOwner(ownerInput);
  const repo = parseGitHubRepoName(repoInput);
  const number = parsePullRequestNumber(numberInput);
  if (
    host._tag === "err" ||
    owner._tag === "err" ||
    repo._tag === "err" ||
    number._tag === "err"
  ) {
    return err({ _tag: "InvalidPullRequestInput" });
  }

  return ok({ host: host.value, owner: owner.value, repo: repo.value, number: number.value });
}
