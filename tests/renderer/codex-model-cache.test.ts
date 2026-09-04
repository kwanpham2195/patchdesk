// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import {
  loadCodexModelCache,
  saveCodexModelCache,
} from "../../src/renderer/src/codex-model-cache";
import type { InsightProviderCatalogModel } from "../../src/renderer/src/insight-catalog-contracts";

const storageKey = "patchdesk.codex-models.v1.profile";

const model: InsightProviderCatalogModel = {
  provider: "codex-cli-account",
  id: "codex/gpt",
  label: "Codex GPT",
  reasoning: ["low", "medium", "high"],
  defaultReasoning: "medium",
};

afterEach(() => window.localStorage.clear());

describe("codex model cache", () => {
  it("round trips a saved catalog", () => {
    saveCodexModelCache("profile", [model]);
    expect(loadCodexModelCache("profile")).toEqual([model]);
    expect(window.localStorage.getItem(storageKey)).toBe(
      JSON.stringify([model]),
    );
  });

  it("returns undefined for an absent cache", () => {
    expect(loadCodexModelCache("profile")).toBeUndefined();
  });

  it("returns undefined for malformed JSON", () => {
    window.localStorage.setItem(storageKey, "not-json");
    expect(loadCodexModelCache("profile")).toBeUndefined();
  });

  it("returns undefined for a non-array payload", () => {
    window.localStorage.setItem(storageKey, JSON.stringify({ models: [] }));
    expect(loadCodexModelCache("profile")).toBeUndefined();
  });

  it("rejects the whole cache on one entry with the wrong provider", () => {
    window.localStorage.setItem(
      storageKey,
      JSON.stringify([model, { ...model, id: "pi/model", provider: "pi" }]),
    );
    expect(loadCodexModelCache("profile")).toBeUndefined();
  });

  it("rejects the whole cache on one entry with an invalid reasoning value", () => {
    window.localStorage.setItem(
      storageKey,
      JSON.stringify([
        model,
        { ...model, id: "codex/bad", reasoning: ["extreme"] },
      ]),
    );
    expect(loadCodexModelCache("profile")).toBeUndefined();
  });

  it("rejects an over-long list", () => {
    const models = Array.from({ length: 513 }, (_, index) => ({
      ...model,
      id: `codex/model-${index}`,
    }));
    window.localStorage.setItem(storageKey, JSON.stringify(models));
    expect(loadCodexModelCache("profile")).toBeUndefined();
  });

  it("keeps caches for different profiles separate", () => {
    saveCodexModelCache("profile-a", [model]);
    expect(loadCodexModelCache("profile-b")).toBeUndefined();
    expect(loadCodexModelCache("profile-a")).toEqual([model]);
  });
});
