// PROTOTYPE — issue #119, throwaway. Do not build on this.

/** Every field `maintainerInboxQuery` already returns for a row, so the
 * prototype is arguing about layout rather than about what data exists. */
export type PrototypePullRequestRow = {
  readonly number: number;
  readonly title: string;
  readonly isDraft: boolean;
  readonly author: string;
  readonly updatedAt: string;
  readonly mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  readonly reviewDecision:
    | "APPROVED"
    | "CHANGES_REQUESTED"
    | "REVIEW_REQUIRED"
    | null;
  readonly checks: "SUCCESS" | "FAILURE" | "PENDING" | "ERROR" | null;
  readonly reviewRequestedForMe: boolean;
  readonly labels: ReadonlyArray<string>;
  readonly merged: boolean;
};

export type PrototypeRepoPullRequests = {
  readonly rows: ReadonlyArray<PrototypePullRequestRow>;
  /** `undefined` is the repo whose repository-wide count never came back, so
   * the footer has to read "View all" with no number. */
  readonly totalCount: number | undefined;
  readonly loadError: string | undefined;
};

/** The most PR rows an expanded repo shows before the footer takes over. */
export const prototypeVisibleRowLimit = 10;

const longTitle =
  "Replace the per-request GraphQL rate-limit accounting with a shared budget so a cold start across every watched repository no longer burns the hourly allowance before the inbox finishes its first page";

const authors = [
  "kwanpham2195",
  "matthew-opn",
  "pmquan2cfw",
  "dependabot",
  "renovate",
];

const labelPool = [
  ["bug"],
  ["feature", "needs-design"],
  [],
  ["chore"],
  ["security"],
];

/** Which shape of repository a key stands for. The maintainer's own config is
 * pinned by name so the interesting cases land on repos that are really there;
 * anything else falls through to the hash so a different config still shows
 * every case. */
const pinnedCases = new Map<string, RepoCase>([
  ["kwanpham2195/patchdesk", "rich"],
  ["centraldigital/cfw-sales-crm-api", "forty"],
  ["centraldigital/cfw-bo-staff-api", "authError"],
  ["centraldigital/cfw-bo-portal-bff", "empty"],
  ["centraldigital/cfw-bo-audit-service", "unknownTotal"],
]);

type RepoCase =
  | "rich"
  | "forty"
  | "authError"
  | "empty"
  | "unknownTotal"
  | "ordinary";

const rotatingCases: ReadonlyArray<RepoCase> = [
  "ordinary",
  "rich",
  "ordinary",
  "forty",
  "ordinary",
  "unknownTotal",
  "empty",
  "authError",
];

/** The row the prototype starts selected on: a merged PR, so the design has to
 * keep a merged item visible in a list that is otherwise open PRs. */
export const prototypeSelectedRowKey = "kwanpham2195/patchdesk#412";

export function prototypeRepoKey(owner: string, repo: string): string {
  return `${owner}/${repo}`;
}

export function prototypeRowKey(repoKey: string, number: number): string {
  return `${repoKey}#${number}`;
}

export function prototypePullRequests(
  repoKey: string,
): PrototypeRepoPullRequests {
  switch (repoCase(repoKey)) {
    case "rich":
      return { rows: richRows(), totalCount: 6, loadError: undefined };
    case "forty":
      return {
        rows: generatedRows(repoKey, 40),
        totalCount: 40,
        loadError: undefined,
      };
    case "authError":
      return {
        rows: [],
        totalCount: undefined,
        loadError:
          "GitHub rejected the read: gh auth token for this host is missing the repo scope.",
      };
    case "empty":
      return { rows: [], totalCount: 0, loadError: undefined };
    case "unknownTotal":
      return {
        rows: generatedRows(repoKey, 4),
        totalCount: undefined,
        loadError: undefined,
      };
    case "ordinary": {
      const count = 1 + (hash(repoKey) % 5);
      return {
        rows: generatedRows(repoKey, count),
        totalCount: count,
        loadError: undefined,
      };
    }
  }
}

function repoCase(repoKey: string): RepoCase {
  const pinned = pinnedCases.get(repoKey);
  if (pinned !== undefined) return pinned;
  const rotated = rotatingCases[hash(repoKey) % rotatingCases.length];
  return rotated ?? "ordinary";
}

/** The one repo that carries every hard case at once: the long title, a draft,
 * the selected merged PR, failing checks, and a review waiting on me. */
function richRows(): ReadonlyArray<PrototypePullRequestRow> {
  return [
    {
      number: 418,
      title: longTitle,
      isDraft: false,
      author: "kwanpham2195",
      updatedAt: "2026-09-09T08:12:00Z",
      mergeable: "MERGEABLE",
      reviewDecision: "REVIEW_REQUIRED",
      checks: "PENDING",
      reviewRequestedForMe: false,
      labels: ["performance"],
      merged: false,
    },
    {
      number: 417,
      title: "Sidebar navigation spike",
      isDraft: true,
      author: "matthew-opn",
      updatedAt: "2026-09-08T17:40:00Z",
      mergeable: "UNKNOWN",
      reviewDecision: null,
      checks: null,
      reviewRequestedForMe: false,
      labels: ["prototype"],
      merged: false,
    },
    {
      number: 416,
      title: "Reconcile the observation journal on a lost session write",
      isDraft: false,
      author: "kwanpham2195",
      updatedAt: "2026-09-08T11:02:00Z",
      mergeable: "CONFLICTING",
      reviewDecision: "CHANGES_REQUESTED",
      checks: "FAILURE",
      reviewRequestedForMe: false,
      labels: ["bug", "review"],
      merged: false,
    },
    {
      number: 415,
      title: "Name the merge conflict above the Diff",
      isDraft: false,
      author: "pmquan2cfw",
      updatedAt: "2026-09-07T19:25:00Z",
      mergeable: "MERGEABLE",
      reviewDecision: "REVIEW_REQUIRED",
      checks: "SUCCESS",
      reviewRequestedForMe: true,
      labels: ["needs-review"],
      merged: false,
    },
    {
      number: 414,
      title: "Bump electron-vite to 5.1.0",
      isDraft: false,
      author: "dependabot",
      updatedAt: "2026-09-07T06:00:00Z",
      mergeable: "MERGEABLE",
      reviewDecision: "APPROVED",
      checks: "SUCCESS",
      reviewRequestedForMe: false,
      labels: ["chore"],
      merged: false,
    },
    {
      number: 412,
      title: "Point merge-conflict resolution at the local checkout",
      isDraft: false,
      author: "kwanpham2195",
      updatedAt: "2026-09-06T14:55:00Z",
      mergeable: "MERGEABLE",
      reviewDecision: "APPROVED",
      checks: "SUCCESS",
      reviewRequestedForMe: false,
      labels: [],
      merged: true,
    },
  ];
}

const titles = [
  "Tighten the inbox page size to the visible viewport",
  "Drop the retired workspaceRoots key from the profile schema",
  "Cache avatar bytes per host instead of per profile",
  "Add a regression test for the stale-HEAD merge path",
  "Move the review navigator resize handle onto pointer events",
  "Log the correlation id on every rejected local API call",
];

function generatedRows(
  repoKey: string,
  count: number,
): ReadonlyArray<PrototypePullRequestRow> {
  const seed = hash(repoKey);
  return Array.from({ length: count }, (_unused, index) => {
    const spin = seed + index * 37;
    const title = titles[spin % titles.length] ?? "Untitled pull request";
    return {
      number: 100 + ((seed + index * 7) % 800),
      title,
      isDraft: spin % 11 === 0,
      author: authors[spin % authors.length] ?? "unknown",
      updatedAt: new Date(
        Date.UTC(2026, 8, 9) - (index + 1) * 5 * 3_600_000,
      ).toISOString(),
      mergeable: spin % 9 === 0 ? "CONFLICTING" : "MERGEABLE",
      reviewDecision: spin % 5 === 0 ? "APPROVED" : "REVIEW_REQUIRED",
      checks: spin % 7 === 0 ? "FAILURE" : "SUCCESS",
      reviewRequestedForMe: spin % 4 === 0,
      labels: labelPool[spin % labelPool.length] ?? [],
      merged: false,
    } satisfies PrototypePullRequestRow;
  });
}

function hash(value: string): number {
  let result = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index);
    result = Math.imul(result, 16_777_619) >>> 0;
  }
  return result;
}
