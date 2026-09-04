import type { Hono } from "hono";
import {
  integer,
  maxLength,
  minLength,
  minValue,
  number,
  pipe,
  safeParse,
  strictObject,
  string,
} from "valibot";

import {
  parseGitHubHost,
  parseGitHubOwner,
  parseGitHubRepoName,
  parsePullRequestNumber,
  parseWorkspaceProfileId,
} from "../../domain/ids";
import type { LocalApiContainer } from "../local-api-container";
import { response } from "./http-status";
import { jsonBody } from "./json-body";

/** On-demand resolution of one image embedded in a pull request body or comment. */
export function registerPullRequestImageRoutes(
  app: Hono,
  container: LocalApiContainer,
): void {
  const { pullRequestImages } = container;
  app.post("/v1/reviews/markdown-image", async (context) => {
    const parsed = safeParse(markdownImageSchema, await jsonBody(context));
    if (!parsed.success) return context.json({ error: "invalid_input" }, 400);
    const profileId = parseWorkspaceProfileId(parsed.output.profileId);
    const host = parseGitHubHost(parsed.output.host);
    const owner = parseGitHubOwner(parsed.output.owner);
    const repo = parseGitHubRepoName(parsed.output.repo);
    const prNumber = parsePullRequestNumber(parsed.output.number);
    if (
      profileId._tag === "err" ||
      host._tag === "err" ||
      owner._tag === "err" ||
      repo._tag === "err" ||
      prNumber._tag === "err"
    )
      return context.json({ error: "invalid_input" }, 400);
    return response(
      context,
      await pullRequestImages.resolve({
        profileId: profileId.value,
        pullRequest: {
          host: host.value,
          owner: owner.value,
          repo: repo.value,
          number: prNumber.value,
        },
        imageUrl: parsed.output.url,
      }),
    );
  });
}

const markdownImageSchema = strictObject({
  profileId: pipe(string(), minLength(1)),
  host: pipe(string(), minLength(1)),
  owner: pipe(string(), minLength(1)),
  repo: pipe(string(), minLength(1)),
  number: pipe(number(), integer(), minValue(1)),
  url: pipe(string(), minLength(1), maxLength(2_048)),
});
