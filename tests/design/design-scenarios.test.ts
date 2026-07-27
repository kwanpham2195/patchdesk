// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";

import { installDesignBridge } from "../../src/design/mock-bridge";
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

    window.history.replaceState({}, "", `/${scenarioUrl("review-completed")}`);
    expect(scenarioFromLocation()?.id).toBe("review-completed");
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

  it("exposes completed and prepared workbench scenarios through one boundary", async () => {
    installDesignBridge("review-prepared");
    const prepared = await window.patchdesk.request({ path: "/v1/reviews/load", method: "POST", body: {} });
    expect(prepared.body).toMatchObject({ state: "review_started", session: { id: "design-session" } });

    installDesignBridge("review-completed");
    const completed = await window.patchdesk.request({ path: "/v1/reviews/load", method: "POST", body: {} });
    expect(completed.body).toMatchObject({ state: "completed", session: { id: "design-session" } });
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
