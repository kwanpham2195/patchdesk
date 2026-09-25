import type { Hono } from "hono";
import {
  array,
  literal,
  maxLength,
  minLength,
  pipe,
  safeParse,
  strictObject,
  string,
  variant,
  type InferOutput,
} from "valibot";

import {
  parseFindingId,
  parseGitHubHost,
  parseGitHubOwner,
  parseGitHubRepoName,
  parseGitShaPrefix,
  parseInsightRunId,
  parseLocalBranchName,
  parseReviewId,
  parseWorkspaceProfileId,
  type FindingId,
} from "../../domain/ids";
import type { LocalReviewSourceRequest } from "../../domain/review-source";
import type { LocalApiContainer } from "../local-api-container";
import { response } from "./http-status";
import { jsonBody } from "./json-body";
import {
  parseReviewWriteExpectation,
  reviewWriteExpectationSchema,
} from "./pending-review-command";

/** Opening a local Review on a profile repository's checkout, and applying suggestions to it (ADR 0050). */
export function registerLocalReviewRoutes(
  app: Hono,
  container: LocalApiContainer,
): void {
  app.post("/v1/reviews/open-local", async (context) => {
    const parsed = safeParse(localReviewOpenSchema, await jsonBody(context));
    if (!parsed.success) return context.json({ error: "invalid_input" }, 400);
    const profileId = parseWorkspaceProfileId(parsed.output.profileId);
    const host = parseGitHubHost(parsed.output.host);
    const owner = parseGitHubOwner(parsed.output.owner);
    const repo = parseGitHubRepoName(parsed.output.repo);
    const request = parseSourceRequest(parsed.output.source);
    if (
      profileId._tag === "err" ||
      host._tag === "err" ||
      owner._tag === "err" ||
      repo._tag === "err" ||
      request === undefined
    )
      return context.json({ error: "invalid_input" }, 400);
    return response(
      context,
      await container.localReviewOpening.open({
        profileId: profileId.value,
        repository: { host: host.value, owner: owner.value, repo: repo.value },
        request,
      }),
    );
  });

  // Identity only: the main process derives every range and replacement (ADR 0048).
  app.post("/v1/reviews/local-apply", async (context) => {
    const parsed = safeParse(localApplySchema, await jsonBody(context));
    if (!parsed.success) return context.json({ error: "invalid_input" }, 400);
    const profileId = parseWorkspaceProfileId(parsed.output.profileId);
    const reviewId = parseReviewId(parsed.output.reviewId);
    const runId = parseInsightRunId(parsed.output.runId);
    const expected = parseReviewWriteExpectation(parsed.output.expected);
    const findingIds: FindingId[] = [];
    for (const raw of parsed.output.findingIds) {
      const findingId = parseFindingId(raw);
      if (findingId._tag === "err")
        return context.json({ error: "invalid_input" }, 400);
      findingIds.push(findingId.value);
    }
    if (
      profileId._tag === "err" ||
      reviewId._tag === "err" ||
      runId._tag === "err" ||
      expected === undefined
    )
      return context.json({ error: "invalid_input" }, 400);
    return response(
      context,
      await container.localApply.apply({
        profileId: profileId.value,
        reviewId: reviewId.value,
        runId: runId.value,
        findingIds,
        expected,
      }),
    );
  });

  // Reads file hashes only; it never applies again.
  app.post("/v1/reviews/local-apply/recover", async (context) => {
    const parsed = safeParse(localApplyRecoverSchema, await jsonBody(context));
    if (!parsed.success) return context.json({ error: "invalid_input" }, 400);
    const profileId = parseWorkspaceProfileId(parsed.output.profileId);
    const reviewId = parseReviewId(parsed.output.reviewId);
    if (profileId._tag === "err" || reviewId._tag === "err")
      return context.json({ error: "invalid_input" }, 400);
    return response(
      context,
      await container.localApply.recover(profileId.value, reviewId.value),
    );
  });
}

const localApplySchema = strictObject({
  profileId: pipe(string(), minLength(1)),
  reviewId: pipe(string(), minLength(1)),
  runId: pipe(string(), minLength(1)),
  findingIds: pipe(array(string()), minLength(1), maxLength(50)),
  expected: reviewWriteExpectationSchema,
});

const localApplyRecoverSchema = strictObject({
  profileId: pipe(string(), minLength(1)),
  reviewId: pipe(string(), minLength(1)),
});

const nonEmpty = pipe(string(), minLength(1));
const localReviewOpenSchema = strictObject({
  profileId: nonEmpty,
  host: nonEmpty,
  owner: nonEmpty,
  repo: nonEmpty,
  source: variant("kind", [
    strictObject({ kind: literal("working_tree") }),
    strictObject({
      kind: literal("branch"),
      branch: nonEmpty,
      baseBranch: nonEmpty,
    }),
    strictObject({ kind: literal("commit"), commit: nonEmpty }),
  ]),
});

function parseSourceRequest(
  raw: InferOutput<typeof localReviewOpenSchema>["source"],
): LocalReviewSourceRequest | undefined {
  if (raw.kind === "working_tree") return { kind: "working_tree" };
  if (raw.kind === "commit") {
    const commit = parseGitShaPrefix(raw.commit.toLowerCase());
    return commit._tag === "ok"
      ? { kind: "commit", commit: commit.value }
      : undefined;
  }
  const branch = parseLocalBranchName(raw.branch);
  const baseBranch = parseLocalBranchName(raw.baseBranch);
  return branch._tag === "ok" && baseBranch._tag === "ok"
    ? { kind: "branch", branch: branch.value, baseBranch: baseBranch.value }
    : undefined;
}
