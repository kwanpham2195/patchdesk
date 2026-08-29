import * as v from "valibot";

import type { CommandFailure } from "./command-runner";
import {
  commandTimeoutMs,
  type GhCommandRequest,
  type GhRequestRunner,
  type GitHubReadFailure,
  type GitHubReadOperation,
} from "./gh-request-runner";
import type {
  CheckRunSummary,
  GitHubMergePolicyEvidence,
  MergePolicySnapshot,
} from "../../domain/github-context";
import { type GitSha, parseGitSha } from "../../domain/ids";
import type { PullRequestRef } from "../../domain/pull-request";
import { err, ok, type Result } from "../../domain/result";
import type { WorkspaceProfileConfig } from "../../domain/workspace-profile";
import type { GitHubWriteFailure } from "../../domain/github-write";
import {
  maxMergePolicyPages,
  mergePolicyQuery,
} from "./github-graphql-queries";
import {
  branchProtectionSchema,
  type MergePolicyPage,
  mergePolicyResponseSchema,
  mergeResultSchema,
  repositoryPermissionSchema,
  requiredStatusChecksSchema,
} from "./github-wire-schemas";
import {
  type CommandFailureClassifier,
  completeMergePolicy,
  incompleteMergePolicy,
  parseMergePolicyPage,
  parseOptionalPolicyResponse,
  parseRequiredContexts,
} from "./github-wire-projections";
import { invalid, writeFailure } from "./github-write-failures";
import type {
  BranchProtectionEvidence,
  RepositoryPermissionEvidence,
} from "./github-adapter";

/**
 * GitHub's granular repository-role vocabulary, as reported by the
 * collaborator-permission endpoint's `role_name` field.
 */
const KNOWN_REPOSITORY_ROLES = [
  "admin",
  "maintain",
  "write",
  "triage",
  "read",
  "none",
] as const;
export type KnownRepositoryRole = (typeof KNOWN_REPOSITORY_ROLES)[number];
const KNOWN_REPOSITORY_ROLE_SET: ReadonlySet<string> = new Set(
  KNOWN_REPOSITORY_ROLES,
);
function isKnownRepositoryRole(value: string): value is KnownRepositoryRole {
  return KNOWN_REPOSITORY_ROLE_SET.has(value);
}

/**
 * Reads what GitHub will allow on a merge -- review decision, required
 * checks, the viewer's repository role, branch protection -- and performs the
 * merge itself.
 */
export class GitHubMergePolicyReader {
  constructor(private readonly requests: GhRequestRunner) {}

  /** Run a gh command that returns JSON as the profile's configured GitHub account. */
  private async ghJson(
    profile: WorkspaceProfileConfig,
    request: GhCommandRequest,
  ): Promise<Result<unknown, CommandFailure>> {
    return this.requests.ghJson(profile, request);
  }

  private commandFailure(
    operation: GitHubReadOperation,
    failure: CommandFailure,
    host: string,
  ): Result<never, GitHubReadFailure> {
    return this.requests.commandFailure(operation, failure, host);
  }

  async getMergePolicy(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
    readonly expectedHeadSha: GitSha;
  }): Promise<Result<MergePolicySnapshot, GitHubReadFailure>> {
    const contexts: Array<CheckRunSummary> = [];
    let cursor: string | undefined;
    let policyPage: MergePolicyPage | undefined;
    for (let page = 0; page < maxMergePolicyPages; page += 1) {
      const response = await this.ghJson(input.profile, {
        argv: [
          "gh",
          "api",
          "graphql",
          "--hostname",
          input.profile.githubHost,
          "-f",
          `query=${mergePolicyQuery}`,
          "-F",
          `owner=${input.pr.owner}`,
          "-F",
          `name=${input.pr.repo}`,
          "-F",
          `number=${input.pr.number}`,
          ...(cursor === undefined ? [] : ["-F", `cursor=${cursor}`]),
        ],
        timeoutMs: commandTimeoutMs,
      });
      if (response._tag === "err")
        return this.commandFailure(
          "get_merge_policy",
          response.error,
          input.profile.githubHost,
        );
      const raw = v.safeParse(mergePolicyResponseSchema, response.value);
      if (!raw.success) return invalid("get_merge_policy");
      const parsed = parseMergePolicyPage(raw.output);
      if (parsed === undefined) return invalid("get_merge_policy");
      if (
        policyPage !== undefined &&
        (parsed.headSha !== policyPage.headSha ||
          parsed.baseSha !== policyPage.baseSha)
      )
        return ok(incompleteMergePolicy(input.pr, parsed, contexts, "mapping"));
      policyPage = parsed;
      contexts.push(...parsed.contexts);
      if (!parsed.hasNextPage) break;
      cursor = parsed.endCursor;
      if (cursor === undefined)
        return ok(
          incompleteMergePolicy(input.pr, parsed, contexts, "pagination"),
        );
    }
    if (policyPage === undefined) return invalid("get_merge_policy");
    if (policyPage.hasNextPage)
      return ok(
        incompleteMergePolicy(input.pr, policyPage, contexts, "pagination"),
      );
    if (policyPage.headSha !== input.expectedHeadSha)
      return ok(
        incompleteMergePolicy(input.pr, policyPage, contexts, "head_mismatch"),
      );

    const required = await this.ghJson(input.profile, {
      argv: [
        "gh",
        "api",
        "--hostname",
        input.profile.githubHost,
        `repos/${input.pr.owner}/${input.pr.repo}/branches/${encodeURIComponent(policyPage.baseBranch)}/protection/required_status_checks`,
      ],
      timeoutMs: commandTimeoutMs,
    });
    // GitHub returns 404 when the branch has no classic required-status-check
    // policy. Rulesets remain available through the GraphQL policy read above.
    // All other failures stay fail-closed because the required checks are unknown.
    if (required._tag === "err") {
      if (required.error._tag === "CommandNotFound")
        return ok(
          completeMergePolicy(input.pr, policyPage, contexts, new Set()),
        );
      return ok(
        incompleteMergePolicy(input.pr, policyPage, contexts, "permission"),
      );
    }
    const rawRequired = v.safeParse(requiredStatusChecksSchema, required.value);
    if (!rawRequired.success)
      return ok(
        incompleteMergePolicy(input.pr, policyPage, contexts, "mapping"),
      );
    const requiredContexts = parseRequiredContexts(rawRequired.output);
    return ok(
      completeMergePolicy(input.pr, policyPage, contexts, requiredContexts),
    );
  }

  async getRepositoryPermission(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
    readonly account: string;
  }): Promise<Result<RepositoryPermissionEvidence, GitHubReadFailure>> {
    const response = await this.ghJson(input.profile, {
      argv: [
        "gh",
        "api",
        "--hostname",
        input.profile.githubHost,
        `repos/${input.pr.owner}/${input.pr.repo}/collaborators/${encodeURIComponent(input.account)}/permission`,
      ],
      timeoutMs: commandTimeoutMs,
    });
    if (response._tag === "err")
      return this.commandFailure(
        "get_repository_permission",
        response.error,
        input.profile.githubHost,
      );
    const parsed = v.safeParse(repositoryPermissionSchema, response.value);
    if (!parsed.success) return invalid("get_repository_permission");
    const roleName = parsed.output.role_name;
    // A GitHub custom repository role reports a role_name this codebase has
    // never seen. Degrade it to an explicit "unknown" state with every
    // derived capability denied, rather than failing the whole read closed —
    // see ADR "Choose a validation style by data boundary" (0022).
    const permission = isKnownRepositoryRole(roleName) ? roleName : "unknown";
    return ok({
      account: input.account,
      permission,
      pullRequestsWrite:
        permission === "admin" ||
        permission === "maintain" ||
        permission === "write",
      // Apply/dismiss-labels is granted to triage and above, not just the
      // pull-request-write roles: https://docs.github.com/en/organizations/managing-user-access-to-your-organizations-repositories/managing-repository-roles/repository-roles-for-an-organization
      canManageLabels:
        permission === "admin" ||
        permission === "maintain" ||
        permission === "write" ||
        permission === "triage",
    });
  }

  async getBranchProtection(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
    readonly branch: string;
  }): Promise<Result<BranchProtectionEvidence, GitHubReadFailure>> {
    const response = await this.ghJson(input.profile, {
      argv: [
        "gh",
        "api",
        "--hostname",
        input.profile.githubHost,
        `repos/${input.pr.owner}/${input.pr.repo}/branches/${encodeURIComponent(input.branch)}/protection`,
      ],
      timeoutMs: commandTimeoutMs,
    });
    // GitHub returns 404 for an unprotected branch (rather than an empty policy).
    // Treat that absence as affirmative unprotected evidence; other failures remain
    // fail-closed so malformed or unavailable permission evidence cannot grant writes.
    if (response._tag === "err" && response.error._tag === "CommandNotFound") {
      return ok({ protected: false, allowedDismissers: [] });
    }
    if (response._tag === "err")
      return this.commandFailure(
        "get_branch_protection",
        response.error,
        input.profile.githubHost,
      );
    const parsed = v.safeParse(branchProtectionSchema, response.value);
    if (!parsed.success) return invalid("get_branch_protection");
    const rules = parsed.output.required_pull_request_reviews;
    const restrictions = rules?.dismissal_restrictions;
    return ok({
      protected: rules !== undefined && rules !== null,
      allowedDismissers: restrictions?.users?.map((user) => user.login) ?? [],
    });
  }

  async getMergePolicyEvidence(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
    readonly branch: string;
  }): Promise<Result<GitHubMergePolicyEvidence, GitHubReadFailure>> {
    const [branchProtection, appliedRuleset] = await Promise.all([
      this.ghJson(input.profile, {
        argv: [
          "gh",
          "api",
          "--hostname",
          input.profile.githubHost,
          `repos/${input.pr.owner}/${input.pr.repo}/branches/${encodeURIComponent(input.branch)}/protection`,
        ],
        timeoutMs: commandTimeoutMs,
      }),
      this.ghJson(input.profile, {
        argv: [
          "gh",
          "api",
          "--hostname",
          input.profile.githubHost,
          `repos/${input.pr.owner}/${input.pr.repo}/rules/branches/${encodeURIComponent(input.branch)}`,
        ],
        timeoutMs: commandTimeoutMs,
      }),
    ]);
    const classify: CommandFailureClassifier = (operation, failure) =>
      this.commandFailure(operation, failure, input.profile.githubHost);
    const branch = parseOptionalPolicyResponse(
      branchProtection,
      "branchProtection",
      classify,
    );
    if (branch._tag === "err") return branch;
    const rules = parseOptionalPolicyResponse(
      appliedRuleset,
      "appliedRuleset",
      classify,
    );
    if (rules._tag === "err") return rules;
    return ok({ branchProtection: branch.value, appliedRuleset: rules.value });
  }

  async mergePullRequest(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
    readonly headSha: GitSha;
    readonly method: "merge" | "squash" | "rebase";
  }): Promise<
    Result<{ readonly mergeCommitSha?: GitSha }, GitHubWriteFailure>
  > {
    const response = await this.ghJson(input.profile, {
      argv: [
        "gh",
        "api",
        "--hostname",
        input.profile.githubHost,
        "--method",
        "PUT",
        `repos/${input.pr.owner}/${input.pr.repo}/pulls/${input.pr.number}/merge`,
        "--input",
        "-",
      ],
      stdin: JSON.stringify({ sha: input.headSha, merge_method: input.method }),
      timeoutMs: commandTimeoutMs,
    });
    if (response._tag === "err") return err(writeFailure(response.error));
    const merge = v.safeParse(mergeResultSchema, response.value);
    if (!merge.success || !merge.output.merged)
      return err({
        _tag: "GitHubWriteFailure",
        category: "unavailable",
        message: "GitHub did not confirm the merge.",
      });
    const rawSha = merge.output.sha;
    const sha =
      rawSha === undefined || rawSha === null ? undefined : parseGitSha(rawSha);
    return sha !== undefined && sha._tag === "err"
      ? err({
          _tag: "GitHubWriteFailure",
          category: "unavailable",
          message: "GitHub returned an invalid merge commit.",
        })
      : ok(sha === undefined ? {} : { mergeCommitSha: sha.value });
  }
}
