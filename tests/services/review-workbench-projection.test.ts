import { describe, expect, it } from "vitest";

import { parseRetainedInsight } from "../../src/domain/insight-record";
import { err, ok } from "../../src/domain/result";
import {
  at,
  fixture,
  hash,
  headSha,
  identity,
  profileId,
  review,
  reviewId,
  sessionId,
  snapshot,
  snapshotData,
} from "./review-workbench-projection-fixture";

/**
 * A raw, untrusted JSON-shaped fixture value: exactly what a stored Insight
 * record's `retained` or `retained.value` looks like before the service
 * under test decodes it. Named (rather than `unknown`) so these fixtures
 * satisfy `anti-slop/no-unknown-parameters`, and a named-property object
 * literal (rather than `Record<string, unknown>`) so it isn't itself an
 * unsafe dictionary contract — while staying just as permissive as the
 * malformed literals these tests inject.
 */
type RawJsonObject = Readonly<{
  title?: unknown;
  focus?: unknown;
  chapters?: unknown;
  sections?: unknown;
  prose?: unknown;
  runId?: unknown;
  revision?: unknown;
  generatedAt?: unknown;
  provenance?: unknown;
  value?: unknown;
}>;
type RawJsonValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | ReadonlyArray<unknown>
  | RawJsonObject;

describe("ReviewWorkbenchProjectionService", () => {
  it("projects only the represented Review snapshot and performs no GitHub reads", async () => {
    const value = fixture();
    await expect(
      value.service.loadRepresented({
        profileId,
        sessionId,
        snapshot,
        refreshedAt: at,
        freshness: { _tag: "Fresh" },
      }),
    ).resolves.toMatchObject({
      _tag: "ok",
      value: {
        review: { id: reviewId, status: "open" },
        revision: {
          freshness: "fresh",
          refreshedAt: at,
          reviewedHeadSha: headSha,
        },
        pullRequest: { title: "represented title" },
        commits: [{ message: "represented commit" }],
        checks: { overall: "passing" },
        conversation: { prDescription: "represented description" },
        pendingReview: { state: "pending" },
        directSummary: { state: "confirmed" },
      },
    });
    expect(value.profiles.load).toHaveBeenCalledOnce();
    expect(value.sessions.load).toHaveBeenCalledOnce();
    expect(value.reviews.load).toHaveBeenCalledOnce();
  });

  it("projects the local checkout failure as a clear metadata-only Review warning", async () => {
    const value = fixture(undefined, "local_checkout_unavailable");

    await expect(
      value.service.loadRepresented({
        profileId,
        sessionId,
        snapshot,
        refreshedAt: at,
        freshness: { _tag: "Fresh" },
      }),
    ).resolves.toMatchObject({
      _tag: "ok",
      value: {
        localCheckout: {
          state: "metadata_only",
          message:
            "The local checkout could not be prepared. This Review uses the GitHub snapshot; local file expansion and commit inspection are unavailable.",
        },
      },
    });
  });

  it("carries real {name,color} labels through to the renderer-facing pull request shape", async () => {
    const value = fixture();
    // SAFETY: same shape as `snapshotData` above, only `pullRequest.labels` differs.
    const labeledSnapshot = {
      ...snapshotData,
      pullRequest: {
        ...snapshotData.pullRequest,
        labels: [
          { name: "bug", color: "d73a4a" },
          { name: "enhancement", color: "a2eeef" },
        ],
      },
    } as never;
    await expect(
      value.service.loadRepresented({
        profileId,
        sessionId,
        snapshot: labeledSnapshot,
        refreshedAt: at,
        freshness: { _tag: "Fresh" },
      }),
    ).resolves.toMatchObject({
      _tag: "ok",
      value: {
        pullRequest: {
          labels: [
            { name: "bug", color: "d73a4a" },
            { name: "enhancement", color: "a2eeef" },
          ],
        },
      },
    });
  });

  it("projects represented freshness, analysis and walkthrough defaults, and merge evidence", async () => {
    const value = fixture();
    const result = await value.service.loadRepresented({
      profileId,
      sessionId,
      snapshot,
      refreshedAt: at,
      freshness: {
        _tag: "RevisionChanged",
        detectedAt: at,
        identity: { headSha, baseSha: headSha, canonicalPatchHash: hash },
      },
    });
    expect(result).toMatchObject({
      _tag: "ok",
      value: {
        revision: { freshness: "updates_available" },
        insights: {
          analysis: { status: "not_generated" },
          walkthrough: { status: "not_generated" },
        },
        mergeReadiness: { _tag: "Ready" },
        mergeReasons: [],
      },
    });
  });

  it("ignores a corrupt Insight record and projects the Review as not generated", async () => {
    const value = fixture();
    value.insights.loadTyped.mockResolvedValueOnce(
      // SAFETY: only the `reason` discriminant this service branches on is
      // set; casting to `never` stands in for the full StorageFailure shape.
      err({ reason: "invalid_stored_value" } as never),
    );
    const result = await value.service.loadRepresented({
      profileId,
      sessionId,
      snapshot,
      refreshedAt: at,
      freshness: { _tag: "Fresh" },
    });
    expect(result).toMatchObject({
      _tag: "ok",
      value: {
        insights: {
          analysis: { status: "not_generated" },
          walkthrough: { status: "not_generated" },
        },
      },
    });
  });

  it("fails closed when the Review authority is missing or bound to another Session", async () => {
    const absent = fixture();
    absent.reviews.load.mockResolvedValueOnce(
      // SAFETY: only the `reason` discriminant this service branches on is
      // set; casting to `never` stands in for the full StorageFailure shape.
      err({ reason: "not_found" } as never),
    );
    await expect(
      absent.service.loadRepresented({
        profileId,
        sessionId,
        snapshot,
        refreshedAt: at,
        freshness: { _tag: "Fresh" },
      }),
    ).resolves.toEqual({ _tag: "err", error: { _tag: "ReviewNotFound" } });
    const mismatched = fixture(review({ currentSessionId: "other-session" }));
    await expect(
      mismatched.service.loadRepresented({
        profileId,
        sessionId,
        snapshot,
        refreshedAt: at,
        freshness: { _tag: "Fresh" },
      }),
    ).resolves.toEqual({
      _tag: "err",
      error: { _tag: "SessionStorageUnavailable" },
    });
  });

  /**
   * The two leading conditions at this gate compare the Review's own id and
   * its `currentSessionId`; neither looks at a head SHA, and neither looks at
   * the identity the Review was created under. `sessionRepresentsReview` is
   * the only thing standing between a moved head -- or a Review filed under a
   * different pull request -- and a workbench that renders the stale Session
   * as the represented revision, with its findings, its pending review and
   * its merge actions all offered as current.
   */
  it("fails closed when the Review no longer represents the Session's revision", async () => {
    for (const stale of [
      // SAFETY: a 40-char hex string already satisfies GitSha's runtime shape.
      review({ currentHeadSha: "c".repeat(40) }),
      // SAFETY: a plain owner string already satisfies GitHubOwner's runtime shape.
      review({ identity: { ...identity, owner: "someone-else" } }),
      review({ identity: { ...identity, prNumber: 43 } }),
    ]) {
      await expect(
        fixture(stale).service.loadRepresented({
          profileId,
          sessionId,
          snapshot,
          refreshedAt: at,
          freshness: { _tag: "Fresh" },
        }),
      ).resolves.toEqual({
        _tag: "err",
        error: { _tag: "SessionStorageUnavailable" },
      });
    }
  });

  describe("deriveMergeReasons (via loadRepresented's mergeEvidence)", () => {
    // SAFETY: this test helper builds a `ReviewRemoteSnapshot`-shaped
    // fixture with a custom `mergeEvidence`; cast `as never` for the same
    // reason as `snapshotData` above.
    function snapshotWithMergeEvidence(
      // oxlint-disable-next-line anti-slop/no-unknown-parameters -- test-only fixture builder; the resulting object is cast `as never` below, the same boundary `snapshotData` itself uses.
      mergeEvidence: unknown,
    ) {
      // SAFETY: see the file-level note above `const snapshotData`; this
      // helper only swaps in a caller-supplied `mergeEvidence` fixture.
      return { ...snapshotData, mergeEvidence } as never;
    }

    it("prefers a ruleset-sourced approval count, marking it available instead of partial", async () => {
      const value = fixture();
      const result = await value.service.loadRepresented({
        profileId,
        sessionId,
        snapshot: snapshotWithMergeEvidence({
          mergeable: "mergeable",
          mergeStateStatus: "clean",
          reviewDecision: "review_required",
          policy: {
            branchProtection: { state: "unavailable", reason: "not_found" },
            appliedRuleset: {
              state: "available",
              value: {
                rules: [
                  {
                    type: "pull_request",
                    pullRequestParameters: { requiredApprovingReviewCount: 2 },
                  },
                ],
              },
            },
          },
        }),
        refreshedAt: at,
        freshness: { _tag: "Fresh" },
      });
      expect(result).toMatchObject({
        _tag: "ok",
        value: {
          mergeReasons: [
            {
              code: "review_required",
              message: "2 approving reviews required by ruleset configuration.",
              source: "ruleset_configuration",
              availability: "available",
              openOnGitHub: false,
            },
          ],
        },
      });
    });

    it("still uses classic branch protection when no ruleset count is available", async () => {
      const value = fixture();
      const result = await value.service.loadRepresented({
        profileId,
        sessionId,
        snapshot: snapshotWithMergeEvidence({
          mergeable: "mergeable",
          mergeStateStatus: "clean",
          reviewDecision: "review_required",
          policy: {
            branchProtection: {
              state: "available",
              value: { requiredApprovingReviewCount: 1 },
            },
            appliedRuleset: { state: "unavailable", reason: "not_found" },
          },
        }),
        refreshedAt: at,
        freshness: { _tag: "Fresh" },
      });
      expect(result).toMatchObject({
        _tag: "ok",
        value: {
          mergeReasons: [
            {
              code: "review_required",
              message: "1 approving review required by branch protection.",
              source: "branch_protection",
              availability: "available",
              openOnGitHub: false,
            },
          ],
        },
      });
    });

    it("names requireLastPushApproval and requiredReviewThreadResolution as separate reasons when GitHub reports blocked, and skips the generic fallback", async () => {
      const value = fixture();
      const result = await value.service.loadRepresented({
        profileId,
        sessionId,
        snapshot: snapshotWithMergeEvidence({
          mergeable: "blocked",
          mergeStateStatus: "blocked",
          reviewDecision: "approved",
          policy: {
            branchProtection: { state: "unavailable", reason: "not_found" },
            appliedRuleset: {
              state: "available",
              value: {
                rules: [
                  {
                    type: "pull_request",
                    pullRequestParameters: {
                      requireLastPushApproval: true,
                      requiredReviewThreadResolution: true,
                    },
                  },
                ],
              },
            },
          },
        }),
        refreshedAt: at,
        freshness: { _tag: "Fresh" },
      });
      expect(result).toMatchObject({
        _tag: "ok",
        value: {
          mergeReasons: [
            {
              code: "review_required",
              message:
                "New changes require approval from someone other than the last pusher.",
              source: "ruleset_configuration",
              availability: "available",
            },
            {
              code: "blocked",
              message:
                "All review threads must be resolved before this can merge.",
              source: "ruleset_configuration",
              availability: "available",
            },
          ],
        },
      });
      const reasons =
        result._tag === "ok" ? result.value.mergeReasons : undefined;
      expect(reasons).toHaveLength(2);
      expect(
        reasons?.some((reason) =>
          reason.message.includes("merge requirements are not satisfied"),
        ),
      ).toBe(false);
    });

    it("reports failing checks and an outstanding review requirement together", async () => {
      const value = fixture();
      // SAFETY: see the file-level note above `const snapshotData`; this
      // inline fixture only overrides `checks` and `mergeEvidence`.
      const result = await value.service.loadRepresented({
        profileId,
        sessionId,
        snapshot: {
          ...snapshotData,
          checks: { overall: "failing", checks: [] },
          mergeEvidence: {
            mergeable: "mergeable",
            mergeStateStatus: "clean",
            reviewDecision: "review_required",
          },
          // SAFETY: see the file-level note above `const snapshotData`.
        } as never,
        refreshedAt: at,
        freshness: { _tag: "Fresh" },
      });
      const reasons =
        result._tag === "ok" ? result.value.mergeReasons : undefined;
      expect(reasons).toHaveLength(2);
      expect(reasons).toContainEqual(
        expect.objectContaining({ code: "review_required" }),
      );
      expect(reasons).toContainEqual(
        expect.objectContaining({ code: "checks" }),
      );
    });

    it("treats has_hooks and unstable as mergeable, producing no blocker reason", async () => {
      // Per GitHub's own `MergeStateStatus` semantics, HAS_HOOKS ("Mergeable
      // with passing commit status and pre-receive hooks") and UNSTABLE
      // ("Mergeable with non-passing commit status") both describe a
      // mergeable PR, not a blocked one, so neither should ever produce a
      // `mergeReasons` entry.
      const value = fixture();
      const hasHooks = await value.service.loadRepresented({
        profileId,
        sessionId,
        snapshot: snapshotWithMergeEvidence({
          mergeable: "mergeable",
          mergeStateStatus: "has_hooks",
          reviewDecision: "approved",
        }),
        refreshedAt: at,
        freshness: { _tag: "Fresh" },
      });
      expect(hasHooks).toMatchObject({
        _tag: "ok",
        value: { mergeReasons: [] },
      });

      const unstable = await value.service.loadRepresented({
        profileId,
        sessionId,
        snapshot: snapshotWithMergeEvidence({
          mergeable: "mergeable",
          mergeStateStatus: "unstable",
          reviewDecision: "approved",
        }),
        refreshedAt: at,
        freshness: { _tag: "Fresh" },
      });
      expect(unstable).toMatchObject({
        _tag: "ok",
        value: { mergeReasons: [] },
      });
    });

    it("does not assert unsatisfied requirements when no policy evidence is readable at all", async () => {
      const value = fixture();
      const result = await value.service.loadRepresented({
        profileId,
        sessionId,
        snapshot: snapshotWithMergeEvidence({
          mergeable: "blocked",
          mergeStateStatus: "blocked",
          reviewDecision: "approved",
        }),
        refreshedAt: at,
        freshness: { _tag: "Fresh" },
      });
      expect(result).toMatchObject({
        _tag: "ok",
        value: {
          mergeReasons: [
            {
              code: "blocked",
              source: "github_pr_state",
              availability: "partial",
              openOnGitHub: true,
            },
          ],
        },
      });
      const reasons =
        result._tag === "ok" ? result.value.mergeReasons : undefined;
      expect(reasons?.[0]?.message).not.toMatch(
        /requirements are not satisfied/,
      );
      expect(reasons?.[0]?.message).toMatch(/could not read/i);
    });
  });

  describe("mergeReadiness (via loadRepresented's mergeEvidence)", () => {
    // Each fixture below deliberately sets `pullRequest.reviewState` to the
    // OPPOSITE verdict from `mergeEvidence.reviewDecision`. `deriveMergeReasons`
    // reads the summary's `reviewState` only when no `mergeEvidence` is
    // present, so a result that matches the evidence and contradicts the
    // summary proves the assertion drove the evidence branch, not the
    // fallback.
    function snapshotWithReview(
      reviewDecision: "unknown" | "review_required",
      reviewState: "review_pending" | "approved",
    ) {
      // SAFETY: see the file-level note above `const snapshotData`; this
      // helper only swaps in the two review fields under test.
      return {
        ...snapshotData,
        pullRequest: { ...snapshotData.pullRequest, reviewState },
        mergeEvidence: {
          mergeable: "mergeable",
          mergeStateStatus: "clean",
          reviewDecision,
        },
      } as never;
    }

    it("projects Ready when GitHub reports no review decision and checks pass", async () => {
      const value = fixture();
      const result = await value.service.loadRepresented({
        profileId,
        sessionId,
        // `review_pending` here would map to `review_required` through the
        // summary fallback, so Ready can only come from the evidence.
        snapshot: snapshotWithReview("unknown", "review_pending"),
        refreshedAt: at,
        freshness: { _tag: "Fresh" },
      });
      expect(result).toMatchObject({
        _tag: "ok",
        value: {
          mergeReadiness: { _tag: "Ready", blockers: [], warnings: [] },
          mergeReasons: [],
        },
      });
    });

    it("projects Blocked with github_review when GitHub requires a review", async () => {
      const value = fixture();
      const result = await value.service.loadRepresented({
        profileId,
        sessionId,
        // `approved` here would clear the blocker through the summary
        // fallback, so a `github_review` blocker can only come from the
        // evidence.
        snapshot: snapshotWithReview("review_required", "approved"),
        refreshedAt: at,
        freshness: { _tag: "Fresh" },
      });
      expect(result).toMatchObject({
        _tag: "ok",
        value: {
          mergeReadiness: {
            _tag: "Blocked",
            blockers: ["github_review"],
            warnings: [],
          },
          mergeReasons: [{ code: "review_required" }],
        },
      });
    });

    // The gate stays out of this: the domain rule blocks on checks only for a
    // check GitHub says is required, and the merge gate never passes
    // `hasFailingChecks`. The badge does, so it cannot read Ready above the
    // red checks card the panel shows here.
    it("projects Blocked with failing_check when the checks are red but nothing is required", async () => {
      const value = fixture();
      const result = await value.service.loadRepresented({
        profileId,
        sessionId,
        // SAFETY: see the file-level note above `const snapshotData`; this
        // only swaps the checks summary and the matching merge state.
        snapshot: {
          ...snapshotData,
          checks: {
            overall: "failing",
            checks: [
              {
                name: "lint",
                required: false,
                status: "completed",
                conclusion: "failure",
              },
            ],
          },
          mergeEvidence: {
            mergeable: "mergeable",
            mergeStateStatus: "unstable",
            reviewDecision: "approved",
          },
        } as never,
        refreshedAt: at,
        freshness: { _tag: "Fresh" },
      });
      expect(result).toMatchObject({
        _tag: "ok",
        value: {
          mergeReadiness: {
            _tag: "Blocked",
            blockers: ["failing_check"],
            warnings: [],
          },
          mergeReasons: [{ code: "checks" }],
        },
      });
    });
  });

  it("never falls back to session-only context when the represented snapshot is complete", async () => {
    const value = fixture();
    const result = await value.service.loadRepresented({
      profileId,
      sessionId,
      snapshot,
      refreshedAt: at,
      freshness: { _tag: "Unavailable", detectedAt: at, reason: "github_read" },
    });
    expect(result).toMatchObject({
      _tag: "ok",
      value: {
        pullRequest: { title: "represented title" },
        conversation: { prDescription: "represented description" },
        revision: { freshness: "unavailable" },
      },
    });
  });
});

// This fixture's Session `patchPath` ("/does-not-exist") never resolves, so
// every retained Walkthrough here fails artifact verification and is
// rendered through `loadWalkthroughRecord`'s readable-without-artifact
// fallback. These tests pin that fallback's graceful degradation for
// malformed, missing, and over-length stored data — the exact behavior the
// oxlint-driven refactor from hand-rolled `typeof`/cast walking to a
// valibot-based reader must reproduce byte-for-byte.
describe("ReviewWorkbenchProjectionService walkthrough fallback degradation", () => {
  const walkthroughRunId = "insight-walkthrough-1-aaaaaaaaaaaa-x";

  function walkthroughRecord(value: RawJsonValue) {
    // SAFETY: this fixture is cast `as never` because it stands in for a
    // full, internal `InsightRecord<unknown>` the service never
    // re-validates beyond the fields it reads; every field but `value`
    // already matches its real runtime shape, and `value` is the field
    // under test — deliberately malformed in most cases below.
    return ok({
      schemaVersion: 2,
      reviewId,
      type: "walkthrough",
      nextToken: 1,
      retained: {
        runId: walkthroughRunId,
        revision: { sessionId, headSha, patchHash: hash },
        generatedAt: at,
        provenance: {
          provider: "pi",
          model: "test-model",
          reasoning: "medium",
        },
        value,
      },
      updatedAt: at,
    }) as never;
  }

  async function projectWalkthrough(value: RawJsonValue) {
    const fx = fixture();
    // `loadStoredInsights` calls `loadTyped` twice -- once for the analysis
    // record, once for the walkthrough -- so the stub answers by the `type`
    // argument rather than by call order.
    fx.insights.loadTyped.mockImplementation((async (
      ...args: ReadonlyArray<unknown>
    ) =>
      args[2] === "walkthrough"
        ? walkthroughRecord(value)
        : err({ reason: "not_found" })) as never);
    const result = await fx.service.loadRepresented({
      profileId,
      sessionId,
      snapshot,
      refreshedAt: at,
      freshness: { _tag: "Fresh" },
    });
    if (result._tag !== "ok") throw new Error("expected an ok projection");
    return result.value.insights.walkthrough;
  }

  it("degrades a non-object retained value to every fallback default", async () => {
    const projection = await projectWalkthrough("not an object");
    expect(projection).toMatchObject({
      status: "outdated",
      artifactStatus: "mismatch",
      retained: {
        value: {
          title: "Stored Walkthrough",
          focus: "Stored source evidence is unavailable.",
          chapters: [],
          citationStatus: "unverified",
        },
      },
    });
  });

  it("degrades one malformed chapter to its fallback title and empty sections, without dropping sibling chapters", async () => {
    const projection = await projectWalkthrough({
      title: "Real title",
      chapters: [
        "not an object",
        { title: "Chapter Two", sections: [{ title: "S", prose: "P" }] },
      ],
    });
    expect(projection.retained?.value.chapters).toEqual([
      { id: "chapter-1", title: "Untitled chapter", sections: [] },
      {
        id: "chapter-2",
        title: "Chapter Two",
        sections: [
          {
            id: "section-2-1",
            title: "S",
            prose: "P",
            hunkIds: [],
            hunks: [],
          },
        ],
      },
    ]);
  });

  it("degrades a chapter with a missing sections array to an empty section list", async () => {
    const projection = await projectWalkthrough({
      chapters: [{ title: "Solo" }],
    });
    expect(projection.retained?.value.chapters).toEqual([
      { id: "chapter-1", title: "Solo", sections: [] },
    ]);
  });

  it("falls back non-string title/prose fields to their defaults instead of rejecting the record", async () => {
    const projection = await projectWalkthrough({
      title: 42,
      chapters: [{ title: null, sections: [{ title: [], prose: {} }] }],
    });
    expect(projection.retained?.value.title).toBe("Stored Walkthrough");
    expect(projection.retained?.value.chapters).toEqual([
      {
        id: "chapter-1",
        title: "Untitled chapter",
        sections: [
          {
            id: "section-1-1",
            title: "Untitled section",
            prose: "Stored section text is unavailable.",
            hunkIds: [],
            hunks: [],
          },
        ],
      },
    ]);
  });

  it("truncates an over-length title instead of rejecting the record", async () => {
    const projection = await projectWalkthrough({
      title: "x".repeat(500),
      chapters: [],
    });
    expect(projection.retained?.value.title).toBe("x".repeat(200));
  });

  it("caps chapters at 12 and sections at 32, keeping the leading entries", async () => {
    const projection = await projectWalkthrough({
      chapters: Array.from({ length: 15 }, (_unused, chapterIndex) => ({
        title: `Chapter ${chapterIndex + 1}`,
        sections: Array.from({ length: 40 }, (_unused2, sectionIndex) => ({
          title: `Section ${sectionIndex + 1}`,
          prose: "p",
        })),
      })),
    });
    const chapters = projection.retained?.value.chapters ?? [];
    expect(chapters).toHaveLength(12);
    expect(chapters[0]?.title).toBe("Chapter 1");
    expect(chapters[11]?.title).toBe("Chapter 12");
    expect(chapters[0]?.sections).toHaveLength(32);
  });
});

// `insights.loadTyped` is mocked at the interface boundary everywhere above,
// so it never actually decodes a stored record. These tests make the mock
// behave like the real `InsightStore.loadTyped` — `parseRetainedInsight` for
// the envelope, then the callback `loadStoredInsights` passes for the value
// — so the decode path itself, not just the surrounding service, is tested.
describe("ReviewWorkbenchProjectionService analysis retained decode", () => {
  const analysisRunId = "insight-analysis-1-aaaaaaaaaaaa-x";
  const validReviewResult = {
    changeSummary: "Adds one guarded change.",
    verdict: "approve",
    summary: "Looks fine.",
    findings: [],
    validationPlan: [],
    assumptions: [],
  };

  function stubLoadTyped(
    fx: ReturnType<typeof fixture>,
    rawRetained: RawJsonValue,
  ) {
    fx.insights.loadTyped.mockImplementationOnce(
      // SAFETY: this stand-in for `InsightStore.loadTyped` is cast `as
      // never` because the mock's inferred signature (from the fixture's
      // default zero-argument implementation) doesn't describe the real
      // 4-argument method; the body below reproduces exactly what the real
      // implementation does — `parseRetainedInsight` for the envelope and
      // the caller's `parseRetainedValue` for the value, wrapped in the
      // same record fields (`schemaVersion`/`reviewId`/`type`/`nextToken`/`updatedAt`).
      (async (...args: ReadonlyArray<unknown>) => {
        // SAFETY: `loadStoredInsights` always calls `insights.loadTyped`
        // with `(profileId, reviewId, "analysis", parseRetainedValue)`, so
        // the 4th positional argument is always that value parser; `never`
        // is the only annotation that hands it back to `parseRetainedInsight`
        // without restating `unknown` in a test file.
        const retained = parseRetainedInsight(rawRetained, args[3] as never);
        if (retained._tag === "err")
          return err({ reason: "invalid_stored_value" });
        return ok({
          schemaVersion: 2,
          reviewId,
          type: "analysis",
          nextToken: 1,
          retained: retained.value,
          updatedAt: at,
        });
      }) as never,
    );
  }

  it("decodes a well-formed retained analysis record end to end", async () => {
    const fx = fixture();
    stubLoadTyped(fx, {
      runId: analysisRunId,
      revision: { sessionId, headSha, patchHash: hash },
      generatedAt: at,
      provenance: { provider: "pi", model: "test-model", reasoning: "medium" },
      value: validReviewResult,
    });
    const result = await fx.service.loadRepresented({
      profileId,
      sessionId,
      snapshot,
      refreshedAt: at,
      freshness: { _tag: "Fresh" },
    });
    expect(result).toMatchObject({
      _tag: "ok",
      value: {
        insights: {
          analysis: {
            retained: { value: { changeSummary: "Adds one guarded change." } },
          },
        },
      },
    });
  });

  it("degrades a retained analysis record with a missing runId to not_generated instead of throwing", async () => {
    const fx = fixture();
    stubLoadTyped(fx, {
      revision: { sessionId, headSha, patchHash: hash },
      generatedAt: at,
      provenance: { provider: "pi", model: "test-model", reasoning: "medium" },
      value: validReviewResult,
    });
    const result = await fx.service.loadRepresented({
      profileId,
      sessionId,
      snapshot,
      refreshedAt: at,
      freshness: { _tag: "Fresh" },
    });
    expect(result).toMatchObject({
      _tag: "ok",
      value: { insights: { analysis: { status: "not_generated" } } },
    });
  });

  it("degrades a retained analysis record whose value fails ReviewResult validation to not_generated", async () => {
    const fx = fixture();
    stubLoadTyped(fx, {
      runId: analysisRunId,
      revision: { sessionId, headSha, patchHash: hash },
      generatedAt: at,
      provenance: { provider: "pi", model: "test-model", reasoning: "medium" },
      value: { ...validReviewResult, verdict: "not-a-real-verdict" },
    });
    const result = await fx.service.loadRepresented({
      profileId,
      sessionId,
      snapshot,
      refreshedAt: at,
      freshness: { _tag: "Fresh" },
    });
    expect(result).toMatchObject({
      _tag: "ok",
      value: { insights: { analysis: { status: "not_generated" } } },
    });
  });

  it("degrades a retained analysis record with a blank provenance model to not_generated", async () => {
    const fx = fixture();
    stubLoadTyped(fx, {
      runId: analysisRunId,
      revision: { sessionId, headSha, patchHash: hash },
      generatedAt: at,
      provenance: { provider: "pi", model: "   ", reasoning: "medium" },
      value: validReviewResult,
    });
    const result = await fx.service.loadRepresented({
      profileId,
      sessionId,
      snapshot,
      refreshedAt: at,
      freshness: { _tag: "Fresh" },
    });
    expect(result).toMatchObject({
      _tag: "ok",
      value: { insights: { analysis: { status: "not_generated" } } },
    });
  });
});
