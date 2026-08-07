// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";

import { installDesignBridge } from "../../src/design/mock-bridge";
import { createUnifiedReviewFixture, unifiedReviewInitialState } from "../../src/renderer/src/flows/app-fixtures";
import {
  designScenarios,
  scenarioFromLocation,
  scenarioUrl,
} from "../../src/design/scenarios";

afterEach(() => {
  window.history.replaceState({}, "", "/");
  window.localStorage.clear();
});

describe("Patchdesk Design scenarios", () => {
  it("keeps scenario IDs unique and addressable", () => {
    const ids = designScenarios.map((scenario) => scenario.id);
    expect(new Set(ids).size).toBe(ids.length);

    window.history.replaceState({}, "", `/${scenarioUrl("review-files-default")}`);
    expect(scenarioFromLocation()?.id).toBe("review-files-default");
  });

  it("returns a production-shaped populated inbox from the mock boundary", async () => {
    installDesignBridge("inbox-default");

    const response = await window.patchdesk.request({ path: "/v1/inbox" });

    expect(response.ok).toBe(true);
    expect(response.body).toMatchObject({
      profile: { id: "cfw", label: "CFW" },
      inbox: { dataFreshness: "fresh" },
    });
    if (!isRecord(response.body) || !isRecord(response.body.inbox))
      throw new Error("Expected a mock inbox response");
    expect(Array.isArray(response.body.inbox.rows)).toBe(true);
    expect(response.body.inbox.rows).toHaveLength(6);
  });

  it("exposes unified Review fixtures through one production boundary", async () => {
    installDesignBridge("review-files-default");
    const files = await window.patchdesk.request({ path: "/v1/reviews/load", method: "POST", body: {} });
    expect(files.body).toMatchObject({ state: "review", review: { status: "open" }, session: { id: "fixture-session" } });

    installDesignBridge("review-updates-draft");
    const updates = await window.patchdesk.request({ path: "/v1/reviews/load", method: "POST", body: {} });
    expect(updates.body).toMatchObject({ state: "review", revision: { freshness: "updates_available" } });
  });

  it("keeps terminal and confirmed-publication fixtures readable and mutation-safe", () => {
    for (const state of ["merged", "closed"] as const) {
      const fixture = createUnifiedReviewFixture(state);
      expect(fixture.review.status).toBe(state);
      const reviewEntry = fixture.conversation.entries.find(e => e._tag === "ReviewSummary");
      const commentEntry = fixture.conversation.entries.find(e => e._tag === "IssueComment");
      expect(reviewEntry?._tag === "ReviewSummary" && reviewEntry.review.body).toBe("Published review body");
      expect(commentEntry?._tag === "IssueComment" && commentEntry.comment.body).toBe("Published inline feedback");
      expect(reviewEntry?._tag === "ReviewSummary" && reviewEntry.review.canDismiss).toBe(true);
    }
    const confirmed = createUnifiedReviewFixture("publication-confirmed");
    expect(confirmed.draft).toMatchObject({ state: { _tag: "Local" }, summaryBody: "", items: [] });
    expect(confirmed.conversation.entries.filter(e => e._tag === "ReviewSummary")).toHaveLength(1);
    expect(confirmed.conversation.entries.filter(e => e._tag === "IssueComment")).toHaveLength(1);
  });

  it("maps typed Review fixture states to production initial UI state", () => {
    expect(unifiedReviewInitialState("files-default")).toMatchObject({ section: "files", selectedPath: "src/a.ts" });
    expect(unifiedReviewInitialState("files-finding-selected")).toMatchObject({ section: "findings", selectedFindingId: "mapped" });
    expect(unifiedReviewInitialState("files-commit-selected")).toMatchObject({ section: "commits", selectedCommitSha: "b".repeat(40) });
    expect(unifiedReviewInitialState("insights-overview")).toEqual({ section: "insights" });
    expect(unifiedReviewInitialState("analysis-running")).toEqual({ section: "insights" });
    expect(unifiedReviewInitialState("analysis-current")).toMatchObject({ section: "insights", insightDetail: "analysis" });
    expect(unifiedReviewInitialState("draft-expanded")).toMatchObject({ draftExpanded: true });
    expect(unifiedReviewInitialState("pr-overview")).toMatchObject({ overviewOpen: true });
  });

  it("keeps first-run and outdated Insight fixtures revision-safe", () => {
    const running = createUnifiedReviewFixture("analysis-running");
    expect(running.insights.analysis.retained).toBeUndefined();
    expect(running.insights.analysis.activeRun?.runId).toBe("analysis-first-run");

    for (const state of ["analysis-outdated", "walkthrough-outdated"] as const) {
      const outdated = createUnifiedReviewFixture(state);
      const retained = state === "analysis-outdated" ? outdated.insights.analysis.retained : outdated.insights.walkthrough.retained;
      expect(retained).toBeDefined();
      expect(retained?.headSha).not.toBe(outdated.revision.currentHeadSha);
    }
  });

  it("includes commit and finding inputs consumed by the Review navigator", () => {
    const fixture = createUnifiedReviewFixture("files-commit-selected");
    expect(fixture.commits).toHaveLength(2);
    expect(fixture.commits[0]?.sha).toBe("b".repeat(40));
    expect(fixture.insights.analysis.retained?.value.findings.map((finding) => finding.id)).toContain("mapped");
  });

  it("keeps settings changes in memory only", async () => {
    installDesignBridge("settings-default");

    const response = await window.patchdesk.request({
      path: "/v1/settings",
      method: "PATCH",
      body: { appearance: "light" },
    });
    expect(response.body).toMatchObject({ appearance: "light" });

    const reread = await window.patchdesk.request({ path: "/v1/settings" });
    expect(reread.body).toMatchObject({ appearance: "light" });
  });
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
