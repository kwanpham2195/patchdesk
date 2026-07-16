import {
  parseGitHubHost,
  parseGitHubOwner,
  parseGitHubRepoName,
  parsePullRequestNumber,
  type GitHubHost,
  type WorkspaceProfileId,
} from "../domain/ids";
import {
  parsePullRequestInput,
  type PullRequestInput,
  type PullRequestRef,
} from "../domain/pull-request";
import { err, ok, type Result } from "../domain/result";
import type { WorkspaceProfileConfig } from "../domain/workspace-profile";

export type PullRequestInputParseFailure = {
  readonly _tag: "PullRequestInputParseFailure";
};

export type ProfileSwitchConfirmation = {
  readonly required: boolean;
  readonly targetProfileId?: WorkspaceProfileId;
  readonly reason?: "host_changed" | "account_changed";
};

/** Parses all direct-entry UI forms into the single branded PR reference used by services. */
export function parsePullRequestEntry(
  input:
    | string
    | PullRequestInput
    | {
        readonly _tag: "SeparateFields";
        readonly host?: string;
        readonly owner: string;
        readonly repo: string;
        readonly number: number;
      },
  defaultHost: GitHubHost,
): Result<PullRequestRef, PullRequestInputParseFailure> {
  if (typeof input === "string") return mapLegacyInput(input);
  if (input._tag === "SelectedDashboardPr") return ok(input.pr);
  if (input._tag === "GitHubUrl") return mapLegacyInput(input.url);
  if (input._tag === "CompactRef") return mapLegacyInput(input.value);

  const host =
    input.host === undefined ? ok(defaultHost) : parseGitHubHost(input.host);
  const owner = parseGitHubOwner(input.owner);
  const repo = parseGitHubRepoName(input.repo);
  const number = parsePullRequestNumber(input.number);
  if (
    host._tag === "err" ||
    owner._tag === "err" ||
    repo._tag === "err" ||
    number._tag === "err"
  ) {
    return err({ _tag: "PullRequestInputParseFailure" });
  }
  return ok({
    host: host.value,
    owner: owner.value,
    repo: repo.value,
    number: number.value,
  });
}

/** Finds the best host-compatible profile; owner filters rank a suggestion but never reject entry. */
export function suggestProfile(
  pr: PullRequestRef,
  profiles: ReadonlyArray<WorkspaceProfileConfig>,
): Result<WorkspaceProfileId | undefined, never> {
  const hostMatches = profiles.filter(
    (profile) => profile.githubHost === pr.host,
  );
  const ownerMatch = hostMatches.find((profile) =>
    profile.ownerFilters.includes(pr.owner),
  );
  return ok(ownerMatch?.id ?? hostMatches[0]?.id);
}

/** Makes host/account scope changes explicit before the renderer applies a suggested profile. */
export function profileSwitchConfirmation(
  current: WorkspaceProfileConfig,
  suggested: WorkspaceProfileConfig | undefined,
  pr: PullRequestRef,
): ProfileSwitchConfirmation {
  if (suggested === undefined || suggested.id === current.id)
    return { required: false };
  return {
    required: true,
    targetProfileId: suggested.id,
    reason: current.githubHost !== pr.host ? "host_changed" : "account_changed",
  };
}

function mapLegacyInput(
  value: string,
): Result<PullRequestRef, PullRequestInputParseFailure> {
  const parsed = parsePullRequestInput(value);
  return parsed._tag === "ok"
    ? ok(parsed.value)
    : err({ _tag: "PullRequestInputParseFailure" });
}
