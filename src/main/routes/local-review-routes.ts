import type { Hono } from "hono";
import {
  literal,
  minLength,
  pipe,
  safeParse,
  strictObject,
  string,
  variant,
  type InferOutput,
} from "valibot";

import {
  parseGitHubHost,
  parseGitHubOwner,
  parseGitHubRepoName,
  parseGitShaPrefix,
  parseLocalBranchName,
  parseWorkspaceProfileId,
} from "../../domain/ids";
import type { LocalReviewSourceRequest } from "../../domain/review-source";
import type { LocalApiContainer } from "../local-api-container";
import { response } from "./http-status";
import { jsonBody } from "./json-body";

/** Opening a local Review on a profile repository's checkout (ADR 0050). */
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
}

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
