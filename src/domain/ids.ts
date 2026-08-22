import { err, ok, type Result } from "./result";

/** A primitive refined by the parser that owns its domain invariant. */
export type Brand<T, Name extends string> = T & {
  readonly __brand: Name;
};

export type WorkspaceProfileId = Brand<string, "WorkspaceProfileId">;
export type GitHubHost = Brand<string, "GitHubHost">;
export type GitHubOwner = Brand<string, "GitHubOwner">;
export type GitHubRepoName = Brand<string, "GitHubRepoName">;
export type PullRequestNumber = Brand<number, "PullRequestNumber">;
export type GitSha = Brand<string, "GitSha">;
export type ReviewId = Brand<string, "ReviewId">;
export type ReviewSessionId = Brand<string, "ReviewSessionId">;
export type FindingId = Brand<string, "FindingId">;
/** An opaque GitHub GraphQL review-thread node identifier. */
export type GitHubThreadId = Brand<string, "GitHubThreadId">;
/** GitHub REST pull-request review identifier (serialized integer). */
export type GitHubReviewRestId = Brand<string, "GitHubReviewRestId">;
/** Opaque GitHub GraphQL pull-request review node identifier. */
export type GitHubReviewNodeId = Brand<string, "GitHubReviewNodeId">;
/** Opaque GitHub GraphQL review-comment node identifier. */
export type GitHubReviewCommentId = Brand<string, "GitHubReviewCommentId">;
/** GitHub account login as proven by the authenticated-account reader. */
export type GitHubLogin = Brand<string, "GitHubLogin">;
/** Durable client-owned identifier for one pending-review write intent. */
export type PendingReviewRequestId = Brand<string, "PendingReviewRequestId">;
export type AbsolutePath = Brand<string, "AbsolutePath">;
export type RepoRelativePath = Brand<string, "RepoRelativePath">;
export type IsoTimestamp = Brand<string, "IsoTimestamp">;
export type ContentHash = Brand<string, "ContentHash">;
export type InsightRunId = Brand<string, "InsightRunId">;

export type InvalidDomainValue = {
  readonly _tag: "InvalidDomainValue";
  readonly field: string;
};

const safeSlug = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const hostSyntax = /^[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?$/;
const shaSyntax = /^[a-f0-9]{40,64}$/;
const reviewIdSyntax =
  /^[a-zA-Z0-9.-]+__[a-zA-Z0-9._-]+__[a-zA-Z0-9._-]+__pr-[1-9]\d*__review-[a-f0-9]{12}$/;
const sessionIdSyntax =
  /^[a-zA-Z0-9.-]+__[a-zA-Z0-9._-]+__[a-zA-Z0-9._-]+__pr-[1-9]\d*__sha-[a-f0-9]{8}__base-[a-f0-9]{8}__[a-f0-9]{12}$/;
const isoTimestampSyntax = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const contentHashSyntax = /^[a-f0-9]{64}$/;
const insightRunIdSyntax =
  /^insight-(analysis|walkthrough)-[1-9]\d*-[a-f0-9]{12}-.+$/;

/** Parse a path-safe workspace profile identifier. */
export function parseWorkspaceProfileId(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- this function is the workspace-profile JSON boundary parser; no earlier parser can establish the branded value.
  input: unknown,
): Result<WorkspaceProfileId, InvalidDomainValue> {
  return parseSafeSlug<"WorkspaceProfileId">(input, "workspaceProfileId");
}

/** Parse a GitHub host without URL paths, credentials, or separators. */
export function parseGitHubHost(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- this function is the GitHub-host JSON boundary parser; it validates the raw value immediately below.
  input: unknown,
): Result<GitHubHost, InvalidDomainValue> {
  if (
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- narrows raw boundary input before applying the host syntax invariant.
    typeof input !== "string" ||
    !hostSyntax.test(input)
  ) {
    return err({ _tag: "InvalidDomainValue", field: "githubHost" });
  }

  return ok(brand(input.toLowerCase()));
}

/** Parse a path-safe GitHub owner. */
export function parseGitHubOwner(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- this function is the GitHub-owner JSON boundary parser; no earlier parser can establish the branded value.
  input: unknown,
): Result<GitHubOwner, InvalidDomainValue> {
  return parseSafeSlug<"GitHubOwner">(input, "githubOwner");
}

/** Parse a path-safe GitHub repository name. */
export function parseGitHubRepoName(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- this function is the GitHub-repository JSON boundary parser; no earlier parser can establish the branded value.
  input: unknown,
): Result<GitHubRepoName, InvalidDomainValue> {
  return parseSafeSlug<"GitHubRepoName">(input, "githubRepoName");
}

/** Parse a positive integer pull request number. */
export function parsePullRequestNumber(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- this function is the pull-request-number JSON boundary parser; it validates the raw value immediately below.
  input: unknown,
): Result<PullRequestNumber, InvalidDomainValue> {
  if (
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- narrows raw boundary input before applying the positive-integer invariant.
    typeof input !== "number" ||
    !Number.isSafeInteger(input) ||
    input < 1
  ) {
    return err({ _tag: "InvalidDomainValue", field: "pullRequestNumber" });
  }

  return ok(brand(input));
}

/** Parse a lower-case Git object SHA accepted by Patchdesk. */
export function parseGitSha(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- this function is the Git SHA JSON boundary parser; it validates the raw value immediately below.
  input: unknown,
): Result<GitSha, InvalidDomainValue> {
  if (
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- narrows raw boundary input before applying the Git SHA syntax invariant.
    typeof input !== "string" ||
    !shaSyntax.test(input)
  ) {
    return err({ _tag: "InvalidDomainValue", field: "gitSha" });
  }

  return ok(brand(input));
}

/** Parse a finding ID generated by a review result producer. */
export function parseFindingId(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- this function is the finding-ID JSON boundary parser; no earlier parser can establish the branded value.
  input: unknown,
): Result<FindingId, InvalidDomainValue> {
  return parseSafeSlug<"FindingId">(input, "findingId");
}

/** Parse an opaque GitHub review-thread node identifier. */
export function parseGitHubThreadId(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- this function is the GitHub-thread-ID JSON boundary parser; no earlier parser can establish the branded value.
  input: unknown,
): Result<GitHubThreadId, InvalidDomainValue> {
  return parseSafeSlug<"GitHubThreadId">(input, "githubThreadId");
}

/** Parse a GitHub REST review identifier (a serialized positive integer). */
export function parseGitHubReviewRestId(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- this function is the GitHub REST review-ID JSON boundary parser; it validates the raw value immediately below.
  input: unknown,
): Result<GitHubReviewRestId, InvalidDomainValue> {
  if (
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- narrows raw boundary input before applying the positive-integer string invariant.
    typeof input !== "string" ||
    !/^[1-9]\d*$/.test(input)
  ) {
    return err({ _tag: "InvalidDomainValue", field: "githubReviewRestId" });
  }
  return ok(brand(input));
}

/** Parse an opaque GitHub GraphQL review node identifier. */
export function parseGitHubReviewNodeId(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- this function is the GitHub GraphQL review-ID JSON boundary parser; no earlier parser can establish the branded value.
  input: unknown,
): Result<GitHubReviewNodeId, InvalidDomainValue> {
  return parseSafeSlug<"GitHubReviewNodeId">(input, "githubReviewNodeId");
}

/** Parse an opaque GitHub GraphQL review-comment node identifier. */
export function parseGitHubReviewCommentId(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- this function is the GitHub GraphQL comment-ID JSON boundary parser; no earlier parser can establish the branded value.
  input: unknown,
): Result<GitHubReviewCommentId, InvalidDomainValue> {
  return parseSafeSlug<"GitHubReviewCommentId">(input, "githubReviewCommentId");
}

/** Parse a GitHub account login. */
export function parseGitHubLogin(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- this function is the GitHub-login JSON boundary parser; no earlier parser can establish the branded value.
  input: unknown,
): Result<GitHubLogin, InvalidDomainValue> {
  return parseSafeSlug<"GitHubLogin">(input, "githubLogin");
}

/** Parse a durable pending-review write-request identifier. */
export function parsePendingReviewRequestId(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- this function is the pending-review request-ID JSON boundary parser; it validates the raw value immediately below.
  input: unknown,
): Result<PendingReviewRequestId, InvalidDomainValue> {
  if (
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- narrows raw boundary input before applying the pending-review ID invariant.
    typeof input !== "string" ||
    !/^pending-review-[a-zA-Z0-9._-]+$/.test(input)
  ) {
    return err({ _tag: "InvalidDomainValue", field: "pendingReviewRequestId" });
  }
  return ok(brand(input));
}

/** Build a durable pending-review write-request identifier. */
export function createPendingReviewRequestId(
  now: IsoTimestamp,
): PendingReviewRequestId {
  const compact = now.replace(/[^a-zA-Z0-9.-]/g, "");
  return brand(`pending-review-${compact}`);
}

/** Parse a durable Insight run identifier. */
export function parseInsightRunId(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- this function is the Insight-run-ID JSON boundary parser; it validates the raw value immediately below.
  input: unknown,
): Result<InsightRunId, InvalidDomainValue> {
  if (
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- narrows raw boundary input before applying the Insight-run ID invariant.
    typeof input !== "string" ||
    !insightRunIdSyntax.test(input)
  )
    return err({ _tag: "InvalidDomainValue", field: "insightRunId" });
  return ok(brand(input));
}

/** Parse the path-safe deterministic Review identifier. */
export function parseReviewId(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- this function is the Review-ID JSON boundary parser; it validates the raw value immediately below.
  input: unknown,
): Result<ReviewId, InvalidDomainValue> {
  if (
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- narrows raw boundary input before applying the Review ID invariant.
    typeof input !== "string" ||
    !reviewIdSyntax.test(input)
  ) {
    return err({ _tag: "InvalidDomainValue", field: "reviewId" });
  }

  return ok(brand(input));
}

/** Build the deterministic identifier for one pull request across all heads. */
export function createReviewId(key: {
  readonly profileId: WorkspaceProfileId;
  readonly host: GitHubHost;
  readonly owner: GitHubOwner;
  readonly repo: GitHubRepoName;
  readonly prNumber: PullRequestNumber;
}): ReviewId {
  const readable = `${key.host}__${key.owner}__${key.repo}__pr-${key.prNumber}`;
  const collisionInput = [
    key.profileId,
    key.host,
    key.owner,
    key.repo,
    key.prNumber,
  ].join("\n");

  return brand(`${readable}__review-${fnv1a64(collisionInput).slice(0, 12)}`);
}

/** Parse the path-safe deterministic session folder identifier. */
export function parseReviewSessionId(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- this function is the Review-session-ID JSON boundary parser; it validates the raw value immediately below.
  input: unknown,
): Result<ReviewSessionId, InvalidDomainValue> {
  if (
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- narrows raw boundary input before applying the Review session ID invariant.
    typeof input !== "string" ||
    !sessionIdSyntax.test(input)
  ) {
    return err({ _tag: "InvalidDomainValue", field: "reviewSessionId" });
  }

  return ok(brand(input));
}

/** Parse the UTC millisecond timestamp format stored in Patchdesk artifacts. */
export function parseIsoTimestamp(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- this function is the persisted timestamp JSON boundary parser; it validates the raw value immediately below.
  input: unknown,
): Result<IsoTimestamp, InvalidDomainValue> {
  if (
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- narrows raw boundary input before applying the stored timestamp invariant.
    typeof input !== "string" ||
    !isoTimestampSyntax.test(input)
  ) {
    return err({ _tag: "InvalidDomainValue", field: "isoTimestamp" });
  }

  return ok(brand(input));
}

/** Parse a lower-case SHA-256 content hash used to version local review artifacts. */
export function parseContentHash(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- this function is the content-hash JSON boundary parser; it validates the raw value immediately below.
  input: unknown,
): Result<ContentHash, InvalidDomainValue> {
  if (
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- narrows raw boundary input before applying the content-hash invariant.
    typeof input !== "string" ||
    !contentHashSyntax.test(input)
  ) {
    return err({ _tag: "InvalidDomainValue", field: "contentHash" });
  }

  return ok(brand(input));
}

/** Parse an absolute local filesystem path without performing filesystem I/O. */
export function parseAbsolutePath(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- this function is the absolute-path JSON boundary parser; it validates the raw value immediately below.
  input: unknown,
): Result<AbsolutePath, InvalidDomainValue> {
  if (
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- narrows raw boundary input before applying the absolute-path invariant.
    typeof input !== "string" ||
    !input.startsWith("/") ||
    input.includes("\0")
  ) {
    return err({ _tag: "InvalidDomainValue", field: "absolutePath" });
  }

  return ok(brand(input));
}

/** Parse a repository-relative path that cannot escape a checkout. */
export function parseRepoRelativePath(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- this function is the repository-relative-path JSON boundary parser; it validates the raw value immediately below.
  input: unknown,
): Result<RepoRelativePath, InvalidDomainValue> {
  if (
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- narrows raw boundary input before applying the repository-relative-path invariant.
    typeof input !== "string" ||
    input.length === 0 ||
    input.startsWith("/") ||
    input.includes("\0") ||
    input.split("/").some((part) => part === ".." || part.length === 0)
  ) {
    return err({ _tag: "InvalidDomainValue", field: "repoRelativePath" });
  }

  return ok(brand(input));
}

/** Build the deterministic folder ID for one immutable PR head/base revision. */
export function createReviewSessionId(key: {
  readonly profileId: WorkspaceProfileId;
  readonly host: GitHubHost;
  readonly owner: GitHubOwner;
  readonly repo: GitHubRepoName;
  readonly prNumber: PullRequestNumber;
  readonly headSha: GitSha;
  readonly baseSha: GitSha;
}): ReviewSessionId {
  const readable = `${key.host}__${key.owner}__${key.repo}__pr-${key.prNumber}__sha-${key.headSha.slice(0, 8)}__base-${key.baseSha.slice(0, 8)}`;
  const collisionInput = [
    key.profileId,
    key.host,
    key.owner,
    key.repo,
    key.prNumber,
    key.headSha,
    key.baseSha,
  ].join("\n");

  return brand(`${readable}__${fnv1a64(collisionInput).slice(0, 12)}`);
}

function parseSafeSlug<Name extends string>(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- this helper is the shared path-safe slug boundary parser used by the exported domain parsers.
  input: unknown,
  field: string,
): Result<Brand<string, Name>, InvalidDomainValue> {
  if (
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- narrows raw boundary input before applying the shared slug invariant.
    typeof input !== "string" ||
    !safeSlug.test(input) ||
    input === "." ||
    input === ".."
  ) {
    return err({ _tag: "InvalidDomainValue", field });
  }

  return ok(brand<string, Name>(input));
}

function brand<T, Name extends string>(value: T): Brand<T, Name> {
  // SAFETY: each parser above establishes the specific value invariant before branding.
  return value as Brand<T, Name>;
}

function fnv1a64(value: string): string {
  let hash = 0xcbf29ce484222325n;
  for (const character of value) {
    hash ^= BigInt(character.codePointAt(0) ?? 0);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }

  return hash.toString(16).padStart(16, "0");
}
