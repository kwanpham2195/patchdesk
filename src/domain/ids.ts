import { casesHandled, err, ok, type Result } from "./result";
import type { ReviewSource } from "./review-source";

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
/** A full or abbreviated lower-case commit SHA a maintainer typed; git resolves it to a `GitSha`. */
export type GitShaPrefix = Brand<string, "GitShaPrefix">;
/** A local branch short name that `git check-ref-format --branch` would accept. */
export type LocalBranchName = Brand<string, "LocalBranchName">;
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
/** GitHub limits account login names to 39 characters. */
export const GITHUB_LOGIN_MAX_LENGTH = 39;
const hostSyntax = /^[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?$/;
const shaSyntax = /^[a-f0-9]{40,64}$/;
const shaPrefixSyntax = /^[a-f0-9]{4,64}$/;
/** The readable Review source segment: `pr-<n>` or `local-<kind>-<slug>` (ADR 0050). */
const reviewSourceSegment = String.raw`(?:pr-[1-9]\d*|local-(?:working_tree|branch|commit)-[a-zA-Z0-9._-]+)`;
const reviewIdSyntax = new RegExp(
  String.raw`^[a-zA-Z0-9.-]+__[a-zA-Z0-9._-]+__[a-zA-Z0-9._-]+__${reviewSourceSegment}__review-[a-f0-9]{12}$`,
);
const sessionIdSyntax = new RegExp(
  String.raw`^[a-zA-Z0-9.-]+__[a-zA-Z0-9._-]+__[a-zA-Z0-9._-]+__${reviewSourceSegment}__sha-[a-f0-9]{8}__base-[a-f0-9]{8}__[a-f0-9]{12}$`,
);
/** Keeps a local id segment well inside a 255-byte path component; the full name still enters the hash. */
const LOCAL_SOURCE_SLUG_MAX_LENGTH = 64;
const LOCAL_BRANCH_NAME_MAX_LENGTH = 255;
const isoTimestampSyntax = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const contentHashSyntax = /^[a-f0-9]{64}$/;
const insightRunIdSyntax =
  /^insight-(analysis|walkthrough|brief)-[1-9]\d*-[a-f0-9]{12}-.+$/;

/** Parse a path-safe workspace profile identifier. */
export function parseWorkspaceProfileId(
  input: unknown,
): Result<WorkspaceProfileId, InvalidDomainValue> {
  return parseSafeSlug<"WorkspaceProfileId">(input, "workspaceProfileId");
}

/**
 * Derive a path-safe workspace profile identifier from a workspace name, so
 * the New workspace dialog can ask for a name and nothing else. `taken`
 * carries the ids already stored; a collision takes the first free `-2`,
 * `-3`, … suffix.
 */
export function deriveWorkspaceProfileId(
  label: string,
  taken: ReadonlySet<string>,
): Result<WorkspaceProfileId, InvalidDomainValue> {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (slug === "")
    return err({ _tag: "InvalidDomainValue", field: "workspaceProfileId" });
  let candidate = slug;
  for (let suffix = 2; taken.has(candidate); suffix += 1)
    candidate = `${slug}-${suffix}`;
  return parseWorkspaceProfileId(candidate);
}

/** Parse a GitHub host without URL paths, credentials, or separators. */
export function parseGitHubHost(
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
  input: unknown,
): Result<GitHubOwner, InvalidDomainValue> {
  return parseSafeSlug<"GitHubOwner">(input, "githubOwner");
}

/** Parse a path-safe GitHub repository name. */
export function parseGitHubRepoName(
  input: unknown,
): Result<GitHubRepoName, InvalidDomainValue> {
  return parseSafeSlug<"GitHubRepoName">(input, "githubRepoName");
}

/** Parse a positive integer pull request number. */
export function parsePullRequestNumber(
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

/** Parse a full or abbreviated commit SHA, as `git log --oneline` prints it. */
export function parseGitShaPrefix(
  input: unknown,
): Result<GitShaPrefix, InvalidDomainValue> {
  if (
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- narrows raw boundary input before applying the SHA prefix syntax invariant.
    typeof input !== "string" ||
    !shaPrefixSyntax.test(input)
  ) {
    return err({ _tag: "InvalidDomainValue", field: "gitShaPrefix" });
  }

  return ok(brand(input));
}

/**
 * Parse a local branch short name by the `git check-ref-format --branch`
 * rules. A name that passes cannot contain a newline, which keeps the id
 * collision input in `createReviewId` unambiguous.
 */
export function parseLocalBranchName(
  input: unknown,
): Result<LocalBranchName, InvalidDomainValue> {
  if (
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- narrows raw boundary input before applying git's branch-name rules.
    typeof input !== "string" ||
    input.length === 0 ||
    input.length > LOCAL_BRANCH_NAME_MAX_LENGTH ||
    input === "@" ||
    input.startsWith("-") ||
    input.startsWith("/") ||
    input.endsWith("/") ||
    input.endsWith(".") ||
    input.endsWith(".lock") ||
    input.includes("..") ||
    input.includes("//") ||
    input.includes("@{") ||
    input.split("/").some((component) => component.startsWith(".")) ||
    // oxlint-disable-next-line no-control-regex -- git refuses control characters in ref names; this rejects them.
    /[\u0000-\u0020\u007f~^:?*[\\]/.test(input)
  ) {
    return err({ _tag: "InvalidDomainValue", field: "localBranchName" });
  }

  return ok(brand(input));
}

/** Parse a finding ID generated by a review result producer. */
export function parseFindingId(
  input: unknown,
): Result<FindingId, InvalidDomainValue> {
  return parseSafeSlug<"FindingId">(input, "findingId");
}

/** Parse an opaque GitHub review-thread node identifier. */
export function parseGitHubThreadId(
  input: unknown,
): Result<GitHubThreadId, InvalidDomainValue> {
  return parseSafeSlug<"GitHubThreadId">(input, "githubThreadId");
}

/** Parse a GitHub REST review identifier (a serialized positive integer). */
export function parseGitHubReviewRestId(
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
  input: unknown,
): Result<GitHubReviewNodeId, InvalidDomainValue> {
  return parseSafeSlug<"GitHubReviewNodeId">(input, "githubReviewNodeId");
}

/** Parse an opaque GitHub GraphQL review-comment node identifier. */
export function parseGitHubReviewCommentId(
  input: unknown,
): Result<GitHubReviewCommentId, InvalidDomainValue> {
  return parseSafeSlug<"GitHubReviewCommentId">(input, "githubReviewCommentId");
}

/** Parse a GitHub account login. */
export function parseGitHubLogin(
  input: unknown,
): Result<GitHubLogin, InvalidDomainValue> {
  if (
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- narrows raw boundary input before applying GitHub's account-login length invariant.
    typeof input !== "string" ||
    input.length > GITHUB_LOGIN_MAX_LENGTH
  )
    return err({ _tag: "InvalidDomainValue", field: "githubLogin" });
  return parseSafeSlug<"GitHubLogin">(input, "githubLogin");
}

/** Parse a durable pending-review write-request identifier. */
export function parsePendingReviewRequestId(
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

/** What a Review id is derived from: the profile repository and the Review source spec. */
export type ReviewIdKey = {
  readonly profileId: WorkspaceProfileId;
  readonly host: GitHubHost;
  readonly owner: GitHubOwner;
  readonly repo: GitHubRepoName;
  readonly source: ReviewSource;
};

/** What a Review session id is derived from: the Review id key plus the pinned revision. */
export type ReviewSessionIdKey = ReviewIdKey & {
  readonly headSha: GitSha;
  readonly baseSha: GitSha;
};

/**
 * Build the deterministic identifier for one Review across all heads. A pull
 * request id is byte-identical to the one built before local sources existed,
 * so stored folders keep their names.
 */
export function createReviewId(key: ReviewIdKey): ReviewId {
  const readable = `${key.host}__${key.owner}__${key.repo}__${reviewSourceIdSegment(key.source)}`;
  const collisionInput = [
    key.profileId,
    key.host,
    key.owner,
    key.repo,
    ...reviewSourceCollisionParts(key.source),
  ].join("\n");

  return brand(`${readable}__review-${fnv1a64(collisionInput).slice(0, 12)}`);
}

/** Parse the path-safe deterministic session folder identifier. */
export function parseReviewSessionId(
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

/** Build the deterministic folder ID for one immutable head/base revision of a Review source. */
export function createReviewSessionId(
  key: ReviewSessionIdKey,
): ReviewSessionId {
  const readable = `${key.host}__${key.owner}__${key.repo}__${reviewSourceIdSegment(key.source)}__sha-${key.headSha.slice(0, 8)}__base-${key.baseSha.slice(0, 8)}`;
  const collisionInput = [
    key.profileId,
    key.host,
    key.owner,
    key.repo,
    ...reviewSourceCollisionParts(key.source),
    key.headSha,
    key.baseSha,
  ].join("\n");

  return brand(`${readable}__${fnv1a64(collisionInput).slice(0, 12)}`);
}

function reviewSourceIdSegment(source: ReviewSource): string {
  switch (source.kind) {
    case "pull_request":
      return `pr-${source.prNumber}`;
    case "working_tree":
      return `local-working_tree-${localSourceSlug(source.branch ?? "detached")}`;
    case "branch":
      return `local-branch-${localSourceSlug(source.branch)}`;
    case "commit":
      return `local-commit-${source.commitSha.slice(0, 8)}`;
    default:
      return casesHandled(source);
  }
}

/**
 * The raw source spec for the collision hash. The pull request case is the
 * pre-ADR-0050 input exactly; each local case leads with its kind so two kinds
 * never share an input, and a detached working tree cannot match a branch
 * literally named `detached`.
 */
function reviewSourceCollisionParts(
  source: ReviewSource,
): ReadonlyArray<string | number> {
  switch (source.kind) {
    case "pull_request":
      return [source.prNumber];
    case "working_tree":
      return source.branch === undefined
        ? ["working_tree", "detached"]
        : ["working_tree", "branch", source.branch];
    case "branch":
      return ["branch", source.branch, source.baseBranch];
    case "commit":
      return ["commit", source.commitSha];
    default:
      return casesHandled(source);
  }
}

/** Sanitizes to the id alphabet (`/` becomes `-`); the raw name goes only into the collision hash. */
function localSourceSlug(name: string): string {
  return name
    .replace(/[^a-zA-Z0-9._-]/g, "-")
    .slice(0, LOCAL_SOURCE_SLUG_MAX_LENGTH);
}

function parseSafeSlug<Name extends string>(
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
