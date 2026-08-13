import type { PullRequestRef } from "../../domain/pull-request";

/** Builds the immutable GitHub page used as the sole base for review links. */
export function pullRequestPageUrl(pr: PullRequestRef): URL {
  return new URL(
    `/${pr.owner}/${pr.repo}/pull/${pr.number}`,
    `https://${pr.host}`,
  );
}

/**
 * Resolves an untrusted Markdown/check URL only when it remains on the saved
 * pull request host. The main process repeats HTTPS host validation on open.
 */
export function resolvePullRequestExternalUrl(
  value: string,
  pr: PullRequestRef | undefined,
): string | undefined {
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
    const base = pullRequestPageUrl(pr);
    const url = new URL(value, base);
    if (
      url.protocol !== "https:" ||
      url.hostname !== base.hostname ||
      url.port !== "" ||
      url.username !== "" ||
      url.password !== ""
    ) {
      return undefined;
    }
    return url.toString();
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
