import { AsyncLocalStorage } from "node:async_hooks";

import { describe, expect, it, vi } from "vitest";

import {
  createReviewSessionId,
  parseGitHubHost,
  parseGitHubOwner,
  parseGitHubRepoName,
  parseGitSha,
  parseIsoTimestamp,
  parsePullRequestNumber,
  parseWorkspaceProfileId,
} from "../../src/domain/ids";
import { ok, err, type Result } from "../../src/domain/result";
import { ReviewLifecycleGate } from "../../src/services/review-lifecycle-gate";
import { ReviewOperationCoordinator } from "../../src/services/review-operation-coordinator";
import { ReviewRecoveryService } from "../../src/services/review-recovery-service";
import { ReviewSessionPreparation } from "../../src/services/review-session-preparation";

/**
 * This suite pins the one global lock order this codebase keeps:
 *
 *   the Review lock (`ReviewOperationCoordinator.withReviewLock`) is always
 *   the OUTER lock, and the profile lock (`ReviewLifecycleGate.
 *   withProfileLock`) is always the INNER one.
 *
 * Both locks are non-reentrant and both are held across `await`s, so two
 * callers that take them in opposite orders wait on each other forever
 * (an ABBA deadlock). The order is not a comment here: `LockOrderRecorder`
 * observes real acquisitions through the real gate and the real coordinator
 * and reconstructs, per async task, which locks were actually held when each
 * new one was taken.
 */

type HeldLock = "review" | "profile";

/**
 * Records lock acquisitions of both kinds while still running every
 * operation through the real (non-reentrant, queueing) base classes.
 *
 * `AsyncLocalStorage` carries the set of locks the *current* async task
 * holds across `await` boundaries, so nesting is attributed to the task that
 * actually nested rather than being inferred from a flat, interleaved log.
 * That is what makes an order assertion real: a violation is recorded only
 * when a Review lock is taken by a task that is, at that instant, already
 * inside a profile lock.
 */
class LockOrderRecorder {
  /** `"review>profile"`-style chains, one per acquisition, in order. */
  readonly chains: Array<string> = [];
  /** `"<kind>:<key>:<requested|acquired>"`, for interleaving assertions. */
  readonly events: Array<string> = [];
  /** Non-empty means some task took a Review lock inside a profile lock. */
  readonly violations: Array<string> = [];
  private readonly held = new AsyncLocalStorage<ReadonlyArray<HeldLock>>();

  note(event: string): void {
    this.events.push(event);
  }

  enter<T>(
    kind: HeldLock,
    key: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const outer = this.held.getStore() ?? [];
    if (kind === "review" && outer.includes("profile"))
      this.violations.push(`${[...outer, kind].join(">")} at ${key}`);
    this.chains.push([...outer, kind].join(">"));
    this.note(`${kind}:${key}:acquired`);
    return this.held.run([...outer, kind], operation);
  }
}

class RecordingGate extends ReviewLifecycleGate {
  constructor(private readonly recorder: LockOrderRecorder) {
    super();
  }

  override async withProfileLock<T>(
    profileId: Parameters<ReviewLifecycleGate["withProfileLock"]>[0],
    operation: () => Promise<T>,
  ): Promise<T> {
    this.recorder.note(`profile:${String(profileId)}:requested`);
    return super.withProfileLock(profileId, () =>
      this.recorder.enter("profile", String(profileId), operation),
    );
  }
}

class RecordingCoordinator extends ReviewOperationCoordinator {
  constructor(private readonly recorder: LockOrderRecorder) {
    super();
  }

  override async withReviewLock<T>(
    profileId: string,
    reviewId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const key = `${profileId}:${reviewId}`;
    this.recorder.note(`review:${key}:requested`);
    return super.withReviewLock(profileId, reviewId, () =>
      this.recorder.enter("review", key, operation),
    );
  }
}

function must<T>(result: Result<T, unknown>): T {
  if (result._tag === "err") throw new Error("fixture");
  return result.value;
}

const profileId = must(parseWorkspaceProfileId("cfw"));
const at = must(parseIsoTimestamp("2026-08-01T00:00:00.000Z"));
const headSha = must(parseGitSha("a".repeat(40)));
const baseSha = must(parseGitSha("b".repeat(40)));
const pullRequest = {
  host: must(parseGitHubHost("github.com")),
  owner: must(parseGitHubOwner("centraldigital")),
  repo: must(parseGitHubRepoName("patchdesk")),
  number: must(parsePullRequestNumber(42)),
};
const reviewId = "github.com__centraldigital__patchdesk__pr-42__review-aaaa";
const sessionId = createReviewSessionId({
  profileId,
  host: pullRequest.host,
  owner: pullRequest.owner,
  repo: pullRequest.repo,
  prNumber: pullRequest.number,
  headSha,
  baseSha,
});

// SAFETY: This test-only fixture supplies the fields exercised by the behavior under test; the cast stays at the test seam and does not weaken production parsing.
const mergeOperation = {
  operationId: "merge-1",
  profileId,
  reviewId,
  sessionId,
  pr: pullRequest,
  expectedHeadSha: headSha,
  method: "squash",
  acknowledgedWarningCodes: [],
  startedAt: at,
  state: { _tag: "OutcomeUnknown" },
} as never;
// SAFETY: This test-only fixture supplies the fields exercised by the behavior under test; the cast stays at the test seam and does not weaken production parsing.
const review = {
  id: reviewId,
  status: { _tag: "Open" },
  updatedAt: at,
} as never;

/** A promise a test releases by hand, to park one service mid-operation. */
type Barrier = {
  readonly wait: Promise<void>;
  readonly release: () => void;
};

function barrier(): Barrier {
  let release: (() => void) | undefined;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { wait, release: () => release?.() } satisfies Barrier;
}

type RecoveryStubs = {
  readonly scan?: () => Promise<void>;
  readonly listPending?: () => Promise<void>;
};

function recoveryService(
  recorder: LockOrderRecorder,
  gate: ReviewLifecycleGate,
  coordinator: ReviewOperationCoordinator,
  stubs: RecoveryStubs = {},
): ReviewRecoveryService {
  return new ReviewRecoveryService(
    // SAFETY: This test-only fixture supplies the fields exercised by the behavior under test; the cast stays at the test seam and does not weaken production parsing.
    {
      list: async () => ok([{ id: profileId }]),
      load: async () => ok({}),
    } as never,
    // SAFETY: This test-only fixture supplies the fields exercised by the behavior under test; the cast stays at the test seam and does not weaken production parsing.
    {
      scanSessionEntries: async () => {
        recorder.note("recovery:scan:started");
        await stubs.scan?.();
        return ok({ sessions: [], invalidEntries: [] });
      },
    } as never,
    () => at,
    {
      lifecycleGate: gate,
      operationCoordinator: coordinator,
      reviews: {
        load: async () => ok(review),
        save: async () => ok(undefined),
      },
      mergeOperations: {
        listPending: async () => {
          recorder.note("recovery:listPending:started");
          await stubs.listPending?.();
          return ok([mergeOperation]);
        },
        removeAfterSessionReceipt: async () => ok(undefined),
      },
      github: {
        getMergeOutcome: async () => ok({ state: "merged", mergedAt: at }),
      },
    },
  );
}

/**
 * The real `ReviewSessionPreparation`, wired only far enough to reach its
 * `lifecycleGate.withProfileLock` call and then fail inside it on the first
 * session read. That is the second half of the deadlock: `open()` and
 * `refresh` both call `prepare()` from inside the Review lock, so the profile
 * lock this service takes is always an inner lock.
 */
function preparationService(
  gate: ReviewLifecycleGate,
  stubs: { readonly beforeLock?: () => Promise<void> } = {},
): ReviewSessionPreparation {
  return new ReviewSessionPreparation(
    // SAFETY: This test-only fixture supplies the fields exercised by the behavior under test; the cast stays at the test seam and does not weaken production parsing.
    {
      profiles: { load: async () => ok({ id: profileId }) },
      sessions: {
        load: async () => err({ reason: "io" }),
      },
      github: {
        getPullRequest: async () => {
          await stubs.beforeLock?.();
          return ok({ headSha, baseSha, isOpen: true });
        },
      },
      now: () => at,
      lifecycleGate: gate,
    } as never,
  );
}

const preparationInput = { profileId, pullRequest };

/** Fail a hung lock in about a second instead of wedging the whole suite. */
async function withinDeadline<T>(
  work: Promise<T>,
  deadlineMs: number,
  what: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                `${what} did not settle within ${deadlineMs}ms — the two ` +
                  "non-reentrant locks were taken in opposite orders",
              ),
            ),
          deadlineMs,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

describe("global lock order: Review lock outer, profile lock inner", () => {
  it("ReviewRecoveryService.reconcile never takes a Review lock inside the profile lock", async () => {
    const recorder = new LockOrderRecorder();
    const recovery = recoveryService(
      recorder,
      new RecordingGate(recorder),
      new RecordingCoordinator(recorder),
    );

    await expect(recovery.reconcile()).resolves.toEqual({
      recovered: 1,
      failed: 0,
    });

    // Both locks are still taken — this is an order assertion, not a
    // "the lock went away" assertion.
    expect(recorder.chains).toContain("profile");
    expect(recorder.chains).toContain("review");
    // …and neither Review lock was taken from inside a profile lock.
    expect(recorder.violations).toEqual([]);
    expect(
      recorder.chains.filter((chain) => chain.startsWith("profile>")),
    ).toEqual([]);
  });

  it("ReviewRecoveryService.reconcileReview takes only the Review lock", async () => {
    const recorder = new LockOrderRecorder();
    const recovery = recoveryService(
      recorder,
      new RecordingGate(recorder),
      new RecordingCoordinator(recorder),
    );

    await expect(
      // SAFETY: This test-only fixture supplies the fields exercised by the behavior under test; the cast stays at the test seam and does not weaken production parsing.
      recovery.reconcileReview(profileId, reviewId as never),
    ).resolves.toEqual({ recovered: 1, failed: 0 });

    expect(recorder.chains).toEqual(["review"]);
    expect(recorder.violations).toEqual([]);
  });

  it("ReviewSessionPreparation.prepare takes the profile lock inside its caller's Review lock", async () => {
    const recorder = new LockOrderRecorder();
    const gate = new RecordingGate(recorder);
    const coordinator = new RecordingCoordinator(recorder);
    const preparation = preparationService(gate);

    // Exactly how `ReviewWorkbenchController.open` and `ReviewRefreshService.
    // refresh` reach `prepare()`: already holding this Review's lock.
    const prepared = await coordinator.withReviewLock(profileId, reviewId, () =>
      preparation.prepare(preparationInput),
    );

    expect(prepared).toEqual(err({ _tag: "SessionStorageUnavailable" }));
    expect(recorder.chains).toEqual(["review", "review>profile"]);
    expect(recorder.violations).toEqual([]);
  });

  it("recovery and preparation do not deadlock when they run at the same time", async () => {
    const recorder = new LockOrderRecorder();
    const gate = new RecordingGate(recorder);
    const coordinator = new RecordingCoordinator(recorder);
    const scan = barrier();
    const listPending = barrier();
    const recovery = recoveryService(recorder, gate, coordinator, {
      scan: () => scan.wait,
      listPending: () => listPending.wait,
    });
    const preparation = preparationService(gate);

    // 1. Recovery starts. It parks inside the profile lock (its session
    //    sweep) and, separately, before asking for any Review lock.
    const reconciled = recovery.reconcile();
    await vi.waitFor(() => {
      expect(recorder.events).toContain(`profile:${profileId}:acquired`);
      expect(recorder.events).toContain("recovery:listPending:started");
    });

    // 2. Preparation takes the Review lock, then queues behind recovery for
    //    the profile lock. Waiting for the *request* event makes this
    //    ordering deterministic rather than timing-dependent.
    const prepared = coordinator.withReviewLock(profileId, reviewId, () =>
      preparation.prepare(preparationInput),
    );
    await vi.waitFor(() => {
      expect(recorder.events).toContain(
        `review:${profileId}:${reviewId}:acquired`,
      );
      expect(
        recorder.events.filter(
          (event) => event === `profile:${profileId}:requested`,
        ).length,
      ).toBeGreaterThanOrEqual(2);
    });

    // 3. Recovery now asks for the Review lock preparation holds. Before the
    //    fix, recovery still held the profile lock preparation is waiting
    //    for, and releasing the sweep below could not break the cycle: the
    //    profile lock stayed held until the merge branch finished, and the
    //    merge branch was waiting on preparation. Both sides hung forever.
    listPending.release();
    scan.release();

    await expect(
      withinDeadline(
        Promise.all([reconciled, prepared]),
        1000,
        "recovery racing preparation",
      ),
    ).resolves.toEqual([
      { recovered: 1, failed: 0 },
      err({ _tag: "SessionStorageUnavailable" }),
    ]);
    expect(recorder.violations).toEqual([]);
  });
});
