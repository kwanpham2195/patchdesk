import type { AppDestination } from "../routes";

const fixtureHashes = new Set([
  "#mermaid-fixture",
  "#diff-fixture",
  "#run-fixture",
  "#workbench-fixture",
  "#workbench-empty-labels-fixture",
  "#workbench-empty-assignees-fixture",
  "#workbench-assignees-denied-fixture",
  "#workbench-assignees-unknown-fixture",
  "#workbench-assignees-write-failure-fixture",
  "#workbench-assignees-cap-fixture",
  "#workbench-assignees-read-failure-fixture",
  "#workbench-merged-fixture",
  "#conversation-rail-fixture",
  "#walkthrough-fixture",
  "#long-workbench-fixture",
  "#active-follow-fixture",
  "#performance-fixture",
  "#submission-fixture",
  "#merge-fixture",
  "#blocked-merge-fixture",
  "#acknowledgement-merge-fixture",
  "#overview-detail-fixture",
]);

export function isFixtureHash(hash: string): boolean {
  return fixtureHashes.has(hash);
}

export function fixtureDestination(hash: string): AppDestination {
  return {
    kind: "workbench",
    reviewId:
      hash === "#performance-fixture"
        ? "performance-fixture"
        : hash === "#diff-fixture"
          ? "fixture"
          : "fixture-session",
  };
}
