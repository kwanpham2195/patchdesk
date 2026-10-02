import * as v from "valibot";

import { err, ok, type Result } from "../../domain/result";
import {
  gitHubApiOrigin,
  gitHubRestHeaders,
  type GitHubFetch,
} from "./github-http-client";

/** Release pages outside this prefix are never offered as a link. */
const releasePagePrefix = "https://github.com/kwanpham2195/patchdesk/releases/";

const checkTimeoutMs = 15_000;

const latestReleaseSchema = v.looseObject({
  tag_name: v.string(),
  html_url: v.pipe(v.string(), v.startsWith(releasePagePrefix)),
  draft: v.boolean(),
  prerelease: v.boolean(),
});

/** The latest published, non-prerelease Patchdesk release. */
export type PatchdeskRelease = {
  readonly tagName: string;
  readonly releaseUrl: string;
};

/** Why the release check has no answer; the caller logs it and shows nothing. */
export type LatestReleaseFailure = {
  readonly _tag: "LatestReleaseUnavailable";
  readonly reason: "network" | "rate_limited" | "status" | "invalid_response";
  readonly status?: number;
};

/**
 * Reads `GET /repos/kwanpham2195/patchdesk/releases/latest` with no token,
 * over the same transport as every other GitHub call (ADR 0046). GitHub
 * already leaves drafts and prereleases out of `latest`; both are refused
 * again here so the contract does not rest on that.
 */
export async function fetchLatestPatchdeskRelease(
  fetch: GitHubFetch,
): Promise<Result<PatchdeskRelease | undefined, LatestReleaseFailure>> {
  let response: Response;
  try {
    response = await fetch(
      `${gitHubApiOrigin("github.com").rest}/repos/kwanpham2195/patchdesk/releases/latest`,
      {
        method: "GET",
        headers: gitHubRestHeaders(),
        signal: AbortSignal.timeout(checkTimeoutMs),
      },
    );
  } catch {
    return err({ _tag: "LatestReleaseUnavailable", reason: "network" });
  }
  if (!response.ok)
    return err({
      _tag: "LatestReleaseUnavailable",
      reason:
        response.status === 403 || response.status === 429
          ? "rate_limited"
          : "status",
      status: response.status,
    });
  const parsed = v.safeParse(
    latestReleaseSchema,
    await response.json().catch(() => undefined),
  );
  if (!parsed.success)
    return err({
      _tag: "LatestReleaseUnavailable",
      reason: "invalid_response",
    });
  if (parsed.output.draft || parsed.output.prerelease) return ok(undefined);
  return ok({
    tagName: parsed.output.tag_name,
    releaseUrl: parsed.output.html_url,
  });
}
