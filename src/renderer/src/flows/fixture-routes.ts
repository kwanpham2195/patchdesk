import type { AppDestination } from "../routes";

const fixtureHashes = new Set([
  "#diff-fixture",
  "#run-fixture",
  "#workbench-fixture",
  "#walkthrough-fixture",
  "#long-workbench-fixture",
  "#active-follow-fixture",
  "#performance-fixture",
  "#submission-fixture",
  "#submission-rejection-fixture",
  "#merge-fixture",
]);

export function isFixtureHash(hash: string): boolean {
  return fixtureHashes.has(hash);
}

export function fixtureDestination(hash: string): AppDestination {
  return {
    kind: "workbench",
    sessionId:
      hash === "#performance-fixture"
        ? "performance-fixture"
        : hash === "#diff-fixture"
          ? "fixture"
          : "fixture-session",
  };
}
