import type { PullRequestRef } from "../../domain/pull-request";

/** Builds the immutable GitHub page used as the sole base for review links. */
export function pullRequestPageUrl(pr: PullRequestRef): URL {
  return new URL(
    `/${pr.owner}/${pr.repo}/pull/${pr.number}`,
    `https://${pr.host}`,
  );
}

/**
 * Resolves an untrusted Markdown/check URL the user has to click before
 * anything happens. A comment body routinely links off GitHub -- the docs, a
 * CI provider, an advisory -- and GitHub itself renders those as links, so
 * pinning them to the pull request's own host only turned them into dead
 * text. Every other guard stays: HTTPS only, no port, no embedded
 * credentials, no control characters, and a relative URL still resolves
 * against the pull request's page.
 *
 * The main process re-validates on open, and keeps its own host allowlist for
 * navigation the page starts by itself.
 *
 * An image is not resolved here at all. It is fetched with no click, so an
 * arbitrary host in an `<img src>` would report back that the maintainer
 * opened this pull request, where a link cannot: it needs the user to
 * activate it. `PullRequestImageService` in the main process is the single
 * authority on which image URL is fetched, and keeps that host restriction.
 */
export function resolvePullRequestExternalUrl(
  value: string,
  pr: PullRequestRef | undefined,
): string | undefined {
  return resolveAgainstPullRequest(value, pr)?.toString();
}

/** Applies every guard that does not depend on the URL's host. */
function resolveAgainstPullRequest(
  value: string,
  pr: PullRequestRef | undefined,
): URL | undefined {
  if (pr === undefined) return undefined;
  if (
    value.trim() !== value ||
    Array.from(value).some(
      (character) =>
        (character.codePointAt(0) ?? Number.POSITIVE_INFINITY) <= 0x20,
    )
  ) {
    return undefined;
  }
  try {
    const url = new URL(value, pullRequestPageUrl(pr));
    if (
      url.protocol !== "https:" ||
      url.port !== "" ||
      url.username !== "" ||
      url.password !== ""
    ) {
      return undefined;
    }
    return url;
  } catch {
    return undefined;
  }
}

export async function openPullRequestExternalUrl(
  value: string,
  pr: PullRequestRef | undefined,
): Promise<boolean> {
  const url = resolvePullRequestExternalUrl(value, pr);
  if (url === undefined || !("patchdesk" in window)) return false;
  return await window.patchdesk.openExternalHttps(url);
}
