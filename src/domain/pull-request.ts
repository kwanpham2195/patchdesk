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

/**
 * The built-in host, branded through the same parser every other host goes
 * through, so no call site has to assert the brand onto a bare string.
 */
const GITHUB_DOT_COM: GitHubHost = brandedGitHubHost("github.com");

function brandedGitHubHost(value: string): GitHubHost {
  const parsed = parseGitHubHost(value);
  if (parsed._tag !== "ok")
    throw new Error(`Built-in GitHub host is not parseable: ${value}`);
  return parsed.value;
}

/** Parse direct URL or compact owner/repo#number input at the UI boundary. */
export function parsePullRequestInput(
  input: unknown,
  defaultHost: GitHubHost = GITHUB_DOT_COM,
): Result<PullRequestRef, InvalidPullRequestInput> {
  if (typeof input !== "string") {
    return err({ _tag: "InvalidPullRequestInput" });
  }

  const urlMatch = /^https:\/\/([^/]+)\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?$/.exec(
    input,
  );
  if (urlMatch !== null) {
    return parseReference(
      urlMatch[1],
      urlMatch[2],
      urlMatch[3],
      Number(urlMatch[4]),
    );
  }

  const compactMatch = /^([^/]+)\/([^#]+)#(\d+)$/.exec(input);
  if (compactMatch !== null) {
    return parseReference(
      defaultHost,
      compactMatch[1],
      compactMatch[2],
      Number(compactMatch[3]),
    );
  }

  return err({ _tag: "InvalidPullRequestInput" });
}

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

  return ok({
    host: host.value,
    owner: owner.value,
    repo: repo.value,
    number: number.value,
  });
}
