import type { RefusalCause } from "../../domain/github-write-refusal";

/**
 * The one cause-to-phrase map for a GitHub write GitHub refused (issue #755).
 * `action` names the surface's own action, such as "merge". It never repeats
 * GitHub's raw message and sends no one to check GitHub status: a refused
 * write did not happen.
 */
export function refusalCausePhrase(
  cause: RefusalCause,
  action: string,
): string {
  switch (cause) {
    case "not_found":
      return `Patchdesk or GitHub could not find what the ${action} needs.`;
    case "conflict":
      return `GitHub refused the ${action} because the pull request changed on GitHub.`;
    case "not_allowed":
      return `GitHub's branch rules or settings do not allow the ${action} right now.`;
    case "unprocessable":
      return `GitHub could not accept the ${action} as sent.`;
    case "unsupported":
      return `GitHub does not support this ${action}.`;
  }
}
