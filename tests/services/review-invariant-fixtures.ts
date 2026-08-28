import {
  parseGitHubLogin,
  parseGitHubReviewCommentId,
  parseGitHubReviewNodeId,
  parseGitHubReviewRestId,
  parseGitHubThreadId,
  parseRepoRelativePath,
} from "../../src/domain/ids";
import type { Result } from "../../src/domain/result";
import { createReviewRefreshFixtureValues } from "./review-refresh-fixture";

/**
 * The fixture preamble the two cross-flow invariant suites share —
 * `write-invariants.test.ts` and `review-lock-invariants.test.ts`. Both run one
 * table over every entry point of one Review, so both need the same parsed
 * Review, the same async plumbing for parking and releasing a lock, and the
 * same way of observing that a service began.
 *
 * The Review itself comes from `review-refresh-fixture.ts` rather than being
 * rebuilt here: it is the one place in `tests/services/` that already produces
 * a fully parsed Review, session, snapshot and profile.
 */

export const values = createReviewRefreshFixtureValues();

export function must<T>(result: Result<T, unknown>): T {
  if (result._tag === "ok") return result.value;
  throw new Error("Invalid test fixture");
}

export const at = values.at;
export const profileId = values.profileId;
export const reviewId = values.review.id;
/** The exact key both halves of `ReviewOperationCoordinator` lock on. */
export const lockKey = `${profileId}:${reviewId}`;
export const now = () => at;

export const login = must(parseGitHubLogin("fixture"));
export const threadId = must(parseGitHubThreadId("PRRT_kwDORJzsQM0001"));
export const reviewRestId = must(parseGitHubReviewRestId("9001"));
export const reviewNodeId = must(
  parseGitHubReviewNodeId("PRR_kwDORJzsQM7e6QwJ"),
);
export const reviewCommentId = must(
  parseGitHubReviewCommentId("PRRC_kwDORJzsQM7fI2Rd"),
);

export const anchor = {
  path: must(parseRepoRelativePath("src/a.ts")),
  startLine: 1,
  line: 1,
  side: "new" as const,
};

/**
 * The write expectation every command carries. No suite reaches the gate's
 * hash comparison — every `requireFresh` here is a stub — so this is a
 * well-formed placeholder rather than a hash of a real patch file.
 */
export const expected = {
  sessionId: values.session.id,
  headSha: values.headSha,
  // SAFETY: a 64-character hex string, matching parseContentHash's format.
  patchHash: "a".repeat(64) as never,
};

/** A promise a test releases by hand, to park one operation mid-flight. */
export function barrier() {
  let release: (() => void) | undefined;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { wait, release: () => release?.() };
}

/** Let every pending microtask and timer callback run. */
export async function settle(): Promise<void> {
  for (let turn = 0; turn < 5; turn += 1) {
    // react-doctor-disable-next-line react-doctor/async-await-in-loop -- draining turns is inherently sequential
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
  }
}

/**
 * Fail a hung entry point instead of wedging the whole suite. Both suites
 * probe code paths that can genuinely deadlock (two non-reentrant locks, or
 * one taken twice), so a hang must be reported as a failing test rather than
 * as a stalled run.
 */
export async function withinDeadline<T>(
  work: Promise<T>,
  deadlineMs: number,
  what: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`${what} did not settle within ${deadlineMs}ms`));
        }, deadlineMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Records the first touch of any dependency. `stub` wraps one dependency
 * method; calling it is what "the entry point began" means.
 */
export function recorder() {
  const touched: Array<string> = [];
  return {
    touched,
    began: (): boolean => touched.length > 0,
    stub<T>(name: string, value: T): () => Promise<T> {
      return async () => {
        touched.push(name);
        return value;
      };
    },
  };
}

export type Recorder = ReturnType<typeof recorder>;
