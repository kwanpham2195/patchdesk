import { headSha } from "./github-adapter-test-support";

export const account = "octo-dev";
export const reviewId = 9001;
export const reviewNodeId = "PRR_kwDORJzsQM7e6QwJ";
export const threadId = "PRRT_kwDORJzsQM0001";
export const commentId = "PRRC_kwDORJzsQM7fI2Rd";
export const reviewListUrl = `repos/octo-org/patchdesk/pulls/42/reviews?per_page=100&page=1`;

export function reviewsPayload(): string {
  return JSON.stringify([
    {
      id: reviewId,
      node_id: reviewNodeId,
      user: { login: account },
      body: "Summary body",
      state: "PENDING",
      commit_id: headSha,
    },
  ]);
}

/** One GraphQL review-thread node as GitHub reports it. */
type ThreadNodeFixture = {
  readonly id: string;
  readonly isOutdated: boolean;
  readonly path: string;
  readonly line: number;
  readonly startLine: number;
  readonly diffSide: string;
  readonly startDiffSide?: string | undefined;
  readonly comments: {
    readonly nodes: ReadonlyArray<{
      readonly id: string;
      readonly body: string;
      readonly createdAt: string;
      readonly author: { readonly login: string };
      readonly pullRequestReview: {
        readonly id: string;
        readonly state: string;
      };
    }>;
    readonly pageInfo: {
      readonly hasNextPage: boolean;
      readonly endCursor: string | null;
    };
  };
};

export function threadNode(
  overrides: Partial<ThreadNodeFixture> = {},
): ThreadNodeFixture {
  return {
    id: threadId,
    isOutdated: false,
    path: "src/review.ts",
    line: 7,
    startLine: 7,
    diffSide: "RIGHT",
    startDiffSide: "RIGHT",
    comments: {
      nodes: [
        {
          id: commentId,
          body: "Comment body",
          createdAt: "2026-08-09T11:34:50Z",
          author: { login: account },
          pullRequestReview: { id: reviewNodeId, state: "PENDING" },
        },
      ],
      pageInfo: { hasNextPage: false, endCursor: null },
    },
    ...overrides,
  };
}

export function threadsPayload(
  options: {
    readonly node?: ThreadNodeFixture;
    readonly pageInfo?: {
      readonly hasNextPage: boolean;
      readonly endCursor: string | null;
    };
  } = {},
): string {
  return JSON.stringify({
    data: {
      repository: {
        pullRequest: {
          reviewThreads: {
            nodes: [options.node ?? threadNode()],
            pageInfo: options.pageInfo ?? {
              hasNextPage: false,
              endCursor: null,
            },
          },
        },
      },
    },
  });
}
