import { describe, expect, it, vi } from "vitest";

import { mergePullRequest } from "../../src/services/merge-service";
import {
  at,
  fixture,
  headSha,
  identity,
  profileId,
  session,
  sessionId,
  snapshotData,
} from "./review-workbench-projection-fixture";

// Module-scope so both describe blocks below -- required-check
// classification and mergeability classification -- share one fixture
// shape instead of two parallel copies.
function policy(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- test-only fixture builder; the result is cast `as never` below, the same boundary `snapshotData` itself uses.
  checks: unknown,
  complete = true,
) {
  return {
    pr: identity,
    headSha,
    baseSha: headSha,
    isOpen: true,
    isDraft: false,
    mergeability: "mergeable",
    mergeStateStatus: "clean",
    reviewDecision: "approved",
    checks,
    complete,
  };
}
function snapshotWithPolicy(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- test-only fixture builder; the result is cast `as never` below, the same boundary `snapshotData` itself uses.
  mergePolicy: unknown,
) {
  // SAFETY: see the file-level note above `const snapshotData`; this
  // helper only adds a caller-supplied `mergePolicy` fixture.
  return { ...snapshotData, mergePolicy } as never;
}

// The snapshot's `mergePolicy` is the only source that can say whether GitHub
// requires a check. Every fixture below leaves the snapshot's own REST
// `checks` green, so any checks blocker or reason these tests observe can
// only have come from the merge policy.
describe("required-check classification from the snapshot merge policy", () => {
  it("blocks the badge on a required check that has not finished, and says so in the panel", async () => {
    const value = fixture();
    const result = await value.service.loadRepresented({
      profileId,
      sessionId,
      snapshot: snapshotWithPolicy(
        policy({
          overall: "pending",
          checks: [{ name: "ci", required: true, status: "in_progress" }],
        }),
      ),
      refreshedAt: at,
      freshness: { _tag: "Fresh" },
    });
    const projected = result._tag === "ok" ? result.value : undefined;
    // The snapshot's own `checks` are green, so this can only be the policy.
    expect(projected?.checks).toEqual({
      overall: "pending",
      checks: [{ name: "ci", required: true, status: "in_progress" }],
    });
    expect(projected?.mergeReadiness).toMatchObject({
      _tag: "Blocked",
      blockers: ["required_check"],
    });
    expect(projected?.mergeReasons).toEqual([
      {
        code: "checks",
        message: "Required check ci has not finished.",
        source: "checks",
        availability: "available",
        openOnGitHub: false,
      },
    ]);
  });

  // A repository with no classic branch-protection policy answers
  // `.../protection/required_status_checks` with 404, so the adapter builds
  // a complete policy from an empty required set and every check is
  // legitimately `required: false`. Wiring the policy in must not make such
  // a repository start blocking on `required_check`.
  it("does not newly block a repository whose policy names nothing as required", async () => {
    const value = fixture();
    const result = await value.service.loadRepresented({
      profileId,
      sessionId,
      snapshot: snapshotWithPolicy(
        policy({
          overall: "failing",
          checks: [
            {
              name: "lint",
              required: false,
              status: "completed",
              conclusion: "failure",
            },
          ],
        }),
      ),
      refreshedAt: at,
      freshness: { _tag: "Fresh" },
    });
    const projected = result._tag === "ok" ? result.value : undefined;
    // `failing_check` proves the red policy checks drove this, not the
    // snapshot's green REST checks; `required_check` must stay absent.
    expect(projected?.mergeReadiness).toMatchObject({
      _tag: "Blocked",
      blockers: ["failing_check"],
    });
    expect(projected?.mergeReasons).toEqual([
      {
        code: "checks",
        message: "A check on this pull request did not pass.",
        source: "checks",
        availability: "available",
        openOnGitHub: false,
      },
    ]);
  });

  it("keeps an unclassified check neutral when the snapshot carries no policy", async () => {
    const value = fixture();
    const result = await value.service.loadRepresented({
      profileId,
      sessionId,
      // SAFETY: see the file-level note above `const snapshotData`; this
      // inline fixture only overrides `checks`, and carries no
      // `mergePolicy`, so nothing can classify the check.
      snapshot: {
        ...snapshotData,
        checks: {
          overall: "failing",
          checks: [
            {
              name: "lint",
              required: "unknown",
              status: "completed",
              conclusion: "failure",
            },
          ],
        },
      } as never,
      refreshedAt: at,
      freshness: { _tag: "Fresh" },
    });
    const projected = result._tag === "ok" ? result.value : undefined;
    expect(projected?.checks.checks[0]?.required).toBe("unknown");
    expect(projected?.mergeReadiness.blockers).not.toContain("required_check");
    expect(projected?.mergeReasons).toEqual([
      {
        code: "checks",
        message: "A check on this pull request did not pass.",
        source: "checks",
        availability: "available",
        openOnGitHub: false,
      },
    ]);
  });

  // An incomplete policy classified nothing: every check on it is
  // `required: "unknown"` and its context list may be truncated. The
  // snapshot's own REST read stays the better display, and neither can
  // block on `required_check`.
  it("falls back to the snapshot's own checks when the policy read was incomplete", async () => {
    const value = fixture();
    const result = await value.service.loadRepresented({
      profileId,
      sessionId,
      snapshot: snapshotWithPolicy(
        policy({ overall: "unknown", checks: [] }, false),
      ),
      refreshedAt: at,
      freshness: { _tag: "Fresh" },
    });
    const projected = result._tag === "ok" ? result.value : undefined;
    expect(projected?.checks).toEqual(snapshotData.checks);
    expect(projected?.mergeReadiness.blockers).not.toContain("required_check");
  });

  // The merge gate reads `MergePolicySnapshot.checks`; after this wiring so
  // does the badge. One policy fixture, both surfaces, same verdict.
  it("agrees with the merge gate for the same merge policy", async () => {
    const checks = {
      overall: "failing" as const,
      checks: [
        {
          name: "ci",
          required: true as const,
          status: "completed" as const,
          conclusion: "failure" as const,
        },
      ],
    };
    const value = fixture();
    const badge = await value.service.loadRepresented({
      profileId,
      sessionId,
      snapshot: snapshotWithPolicy(policy(checks)),
      refreshedAt: at,
      freshness: { _tag: "Fresh" },
    });
    const merge = vi.fn(async () => ({ _tag: "ok" as const, value: {} }));
    const gate = await mergePullRequest({
      // SAFETY: the profile fields `mergePullRequest` reads are both here.
      profile: { githubHost: "github.com", ghAccount: "fixture" } as never,
      session: session(),
      // SAFETY: this fake gateway stubs only the methods
      // `mergePullRequest` calls; `changedFileCount: 0` matches the empty
      // canonical diff, which is what makes the revision proof hold.
      gateway: {
        getPullRequest: async () => ({
          _tag: "ok" as const,
          value: {
            ref: identity,
            headSha,
            baseSha: headSha,
            changedFileCount: 0,
          },
        }),
        getPullRequestDiff: async () => ({ _tag: "ok" as const, value: "" }),
        getMergePolicy: async () => ({
          _tag: "ok" as const,
          value: { ...policy(checks), pr: identity },
        }),
        mergePullRequest: merge,
      } as never,
      method: "squash",
      supportedMethods: ["squash"],
      acknowledgedWarningCodes: [],
    });
    expect(gate).toMatchObject({
      _tag: "err",
      error: {
        _tag: "MergeBlocked",
        readiness: { blockers: ["required_check"] },
      },
    });
    expect(merge).not.toHaveBeenCalled();
    expect(
      badge._tag === "ok" ? badge.value.mergeReadiness.blockers : undefined,
    ).toContain("required_check");
  });

  // The one place badge and gate are meant to disagree, not a second
  // instance of the bug above. `evaluateMergeReadiness`'s `hasFailingChecks`
  // (see `merge-readiness.ts`) is opt-in and the merge gate never passes it,
  // so a check GitHub does not require -- `unstable`, "mergeable with a
  // non-passing commit status" in GitHub's own terms per ADR 0027 -- blocks
  // only the badge, via `failing_check`, and never refuses the actual merge.
  it("disagrees with the merge gate by design: a failing check nobody required blocks the badge only", async () => {
    const checks = {
      overall: "failing" as const,
      checks: [
        {
          name: "lint",
          required: false as const,
          status: "completed" as const,
          conclusion: "failure" as const,
        },
      ],
    };
    const value = fixture();
    const badge = await value.service.loadRepresented({
      profileId,
      sessionId,
      snapshot: snapshotWithPolicy(policy(checks)),
      refreshedAt: at,
      freshness: { _tag: "Fresh" },
    });
    const merge = vi.fn(async () => ({ _tag: "ok" as const, value: {} }));
    const gate = await mergePullRequest({
      // SAFETY: the profile fields `mergePullRequest` reads are both here.
      profile: { githubHost: "github.com", ghAccount: "fixture" } as never,
      session: session(),
      // SAFETY: this fake gateway stubs only the methods
      // `mergePullRequest` calls; `changedFileCount: 0` matches the empty
      // canonical diff, which is what makes the revision proof hold.
      gateway: {
        getPullRequest: async () => ({
          _tag: "ok" as const,
          value: {
            ref: identity,
            headSha,
            baseSha: headSha,
            changedFileCount: 0,
          },
        }),
        getPullRequestDiff: async () => ({ _tag: "ok" as const, value: "" }),
        getMergePolicy: async () => ({
          _tag: "ok" as const,
          value: { ...policy(checks), pr: identity },
        }),
        mergePullRequest: merge,
      } as never,
      method: "squash",
      supportedMethods: ["squash"],
      acknowledgedWarningCodes: [],
    });
    expect(gate).toMatchObject({ _tag: "ok" });
    expect(merge).toHaveBeenCalledTimes(1);
    expect(
      badge._tag === "ok" ? badge.value.mergeReadiness.blockers : undefined,
    ).toContain("failing_check");
  });
});

// `readinessMergeability` (`review-workbench-projection.ts`) folds
// `mergeable`/`mergeStateStatus` into the one value `evaluateMergeReadiness`
// reads for the badge. The merge gate applies its own fail-closed rule
// straight to the raw policy read (`merge-service.ts`):
// `policy.value.complete ? policy.value.mergeability : "unknown"`. Before
// this fix `readinessMergeability` never consulted `complete`, so an
// incomplete policy -- one that classified nothing reliably -- could still
// read Ready on the badge while the gate refused the same merge with
// `mergeability_unknown`.
describe("mergeability classification from the snapshot merge policy", () => {
  it("fails closed on an incomplete policy even when the raw evidence reads mergeable", async () => {
    const value = fixture();
    const result = await value.service.loadRepresented({
      profileId,
      sessionId,
      snapshot: snapshotWithPolicy(
        policy({ overall: "unknown", checks: [] }, false),
      ),
      refreshedAt: at,
      freshness: { _tag: "Fresh" },
    });
    const projected = result._tag === "ok" ? result.value : undefined;
    expect(projected?.mergeReadiness).toMatchObject({
      _tag: "Blocked",
      blockers: ["mergeability_unknown"],
    });
  });

  // Must not over-block: failing closed on an incomplete read must not make
  // a complete, mergeable policy read blocked.
  it("does not over-block: a complete, mergeable policy still reads Ready", async () => {
    const value = fixture();
    const result = await value.service.loadRepresented({
      profileId,
      sessionId,
      snapshot: snapshotWithPolicy(policy({ overall: "passing", checks: [] })),
      refreshedAt: at,
      freshness: { _tag: "Fresh" },
    });
    const projected = result._tag === "ok" ? result.value : undefined;
    expect(projected?.mergeReadiness).toEqual({
      _tag: "Ready",
      blockers: [],
      warnings: [],
    });
  });

  // One policy fixture, both surfaces, same verdict -- the gate already
  // forces "unknown" here (`merge-service.ts:102`); the badge must now agree
  // rather than reading Ready above a merge the gate refuses.
  it("agrees with the merge gate when the merge policy read is incomplete", async () => {
    const checks = { overall: "unknown" as const, checks: [] };
    const value = fixture();
    const badge = await value.service.loadRepresented({
      profileId,
      sessionId,
      snapshot: snapshotWithPolicy(policy(checks, false)),
      refreshedAt: at,
      freshness: { _tag: "Fresh" },
    });
    const merge = vi.fn(async () => ({ _tag: "ok" as const, value: {} }));
    const gate = await mergePullRequest({
      // SAFETY: the profile fields `mergePullRequest` reads are both here.
      profile: { githubHost: "github.com", ghAccount: "fixture" } as never,
      session: session(),
      // SAFETY: this fake gateway stubs only the methods
      // `mergePullRequest` calls; `changedFileCount: 0` matches the empty
      // canonical diff, which is what makes the revision proof hold.
      gateway: {
        getPullRequest: async () => ({
          _tag: "ok" as const,
          value: {
            ref: identity,
            headSha,
            baseSha: headSha,
            changedFileCount: 0,
          },
        }),
        getPullRequestDiff: async () => ({ _tag: "ok" as const, value: "" }),
        getMergePolicy: async () => ({
          _tag: "ok" as const,
          value: { ...policy(checks, false), pr: identity },
        }),
        mergePullRequest: merge,
      } as never,
      method: "squash",
      supportedMethods: ["squash"],
      acknowledgedWarningCodes: [],
    });
    expect(gate).toMatchObject({
      _tag: "err",
      error: {
        _tag: "MergeBlocked",
        readiness: { blockers: ["mergeability_unknown"] },
      },
    });
    expect(merge).not.toHaveBeenCalled();
    expect(
      badge._tag === "ok" ? badge.value.mergeReadiness.blockers : undefined,
    ).toContain("mergeability_unknown");
  });
});
