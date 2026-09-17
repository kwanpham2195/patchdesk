import type { Context, Hono } from "hono";
import {
  integer,
  minLength,
  minValue,
  number,
  pipe,
  safeParse,
  strictObject,
  string,
} from "valibot";

import {
  parseWorkspaceProfileId,
  type WorkspaceProfileId,
} from "../../domain/ids";
import type { RawJsonValue } from "../../domain/json";
import {
  parsePullRequestRef,
  type PullRequestRef,
} from "../../domain/pull-request";
import { casesHandled, type Result } from "../../domain/result";
import type { WatchedPullRequestFailure } from "../../services/watched-pull-request-service";
import type { LocalApiContainer } from "../local-api-container";
import { jsonBody } from "./json-body";

const watchedPullRequestCommandSchema = strictObject({
  profileId: pipe(string(), minLength(1)),
  pullRequest: strictObject({
    host: pipe(string(), minLength(1)),
    owner: pipe(string(), minLength(1)),
    repo: pipe(string(), minLength(1)),
    number: pipe(number(), integer(), minValue(1)),
  }),
});

type WatchedPullRequestCommand = {
  readonly profileId: WorkspaceProfileId;
  readonly ref: PullRequestRef;
};

/** The profile's watched pull requests, and the Watch and Unwatch commands (ADR 0045). */
export function registerWatchedPullRequestRoutes(
  app: Hono,
  container: LocalApiContainer,
): void {
  const { watchedPullRequests } = container;
  app.get("/v1/watched-pull-requests", async (context) => {
    const profileId = parseWorkspaceProfileId(context.req.query("profileId"));
    if (profileId._tag === "err")
      return context.json({ error: "invalid_input" }, 400);
    return listResponse(
      context,
      await watchedPullRequests.list(profileId.value),
    );
  });
  app.post("/v1/watched-pull-requests", async (context) => {
    const command = parseCommand(await jsonBody(context));
    if (command === undefined)
      return context.json({ error: "invalid_input" }, 400);
    return listResponse(
      context,
      await watchedPullRequests.watch(command.profileId, command.ref),
    );
  });
  app.delete("/v1/watched-pull-requests", async (context) => {
    const command = parseCommand(await jsonBody(context));
    if (command === undefined)
      return context.json({ error: "invalid_input" }, 400);
    return listResponse(
      context,
      await watchedPullRequests.unwatch(command.profileId, command.ref),
    );
  });
}

function parseCommand(
  body: RawJsonValue | undefined,
): WatchedPullRequestCommand | undefined {
  const raw = safeParse(watchedPullRequestCommandSchema, body);
  if (!raw.success) return undefined;
  const profileId = parseWorkspaceProfileId(raw.output.profileId);
  const ref = parsePullRequestRef(raw.output.pullRequest);
  return profileId._tag === "ok" && ref._tag === "ok"
    ? { profileId: profileId.value, ref: ref.value }
    : undefined;
}

function listResponse(
  context: Context,
  result: Result<ReadonlyArray<PullRequestRef>, WatchedPullRequestFailure>,
): Response {
  if (result._tag === "ok") return context.json({ pullRequests: result.value });
  const failure = result.error;
  switch (failure._tag) {
    case "WatchLimitReached":
      // The renderer words the refusal from the tag and limit.
      return context.json({ error: failure }, 400);
    case "WatchedPullRequestNotFound":
      return context.json({ error: "not_found" }, 404);
    case "WatchedPullRequestReadFailed":
      return failure.reason === "GitHubRateLimited"
        ? context.json({ error: "rate_limited" }, 503)
        : failure.reason === "GitHubAuthenticationFailed"
          ? context.json({ error: "github_auth" }, 401)
          : failure.reason === "GitHubForbidden"
            ? context.json({ error: "forbidden" }, 403)
            : context.json({ error: "unavailable" }, 503);
    case "StorageFailure":
      return context.json({ error: "storage" }, 503);
    default:
      return casesHandled(failure);
  }
}
