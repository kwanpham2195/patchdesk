// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import {
  loadAccountModelCache,
  saveAccountModelCache,
} from "../../src/renderer/src/account-model-cache";
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

describe("account model cache", () => {
  it("round trips a saved catalog", () => {
    saveAccountModelCache("codex-cli-account", "profile", [model]);
    expect(loadAccountModelCache("codex-cli-account", "profile")).toEqual([
      model,
    ]);
    expect(window.localStorage.getItem(storageKey)).toBe(
      JSON.stringify([model]),
    );
  });

  it("returns undefined for an absent cache", () => {
    expect(
      loadAccountModelCache("codex-cli-account", "profile"),
    ).toBeUndefined();
  });

  it("returns undefined for malformed JSON", () => {
    window.localStorage.setItem(storageKey, "not-json");
    expect(
      loadAccountModelCache("codex-cli-account", "profile"),
    ).toBeUndefined();
  });

  it("returns undefined for a non-array payload", () => {
    window.localStorage.setItem(storageKey, JSON.stringify({ models: [] }));
    expect(
      loadAccountModelCache("codex-cli-account", "profile"),
    ).toBeUndefined();
  });

  it("rejects the whole cache on one entry with the wrong provider", () => {
    window.localStorage.setItem(
      storageKey,
      JSON.stringify([model, { ...model, id: "pi/model", provider: "pi" }]),
    );
    expect(
      loadAccountModelCache("codex-cli-account", "profile"),
    ).toBeUndefined();
  });

  it("rejects the whole cache on one entry with an invalid reasoning value", () => {
    window.localStorage.setItem(
      storageKey,
      JSON.stringify([
        model,
        { ...model, id: "codex/bad", reasoning: ["extreme"] },
      ]),
    );
    expect(
      loadAccountModelCache("codex-cli-account", "profile"),
    ).toBeUndefined();
  });

  it("rejects an over-long list", () => {
    const models = Array.from({ length: 2049 }, (_, index) => ({
      ...model,
      id: `codex/model-${index}`,
    }));
    window.localStorage.setItem(storageKey, JSON.stringify(models));
    expect(
      loadAccountModelCache("codex-cli-account", "profile"),
    ).toBeUndefined();
  });

  it("keeps the pi CLI account catalog under its own key", () => {
    const piModel: InsightProviderCatalogModel = {
      provider: "pi-cli-account",
      id: "anthropic/claude-sonnet-5",
      label: "anthropic/claude-sonnet-5",
      reasoning: ["low", "medium", "high"],
    };
    saveAccountModelCache("codex-cli-account", "profile", [model]);
    saveAccountModelCache("pi-cli-account", "profile", [piModel]);
    expect(loadAccountModelCache("pi-cli-account", "profile")).toEqual([
      piModel,
    ]);
    expect(loadAccountModelCache("codex-cli-account", "profile")).toEqual([
      model,
    ]);
    window.localStorage.setItem(
      "patchdesk.pi-cli-models.v1.profile",
      JSON.stringify([model]),
    );
    expect(loadAccountModelCache("pi-cli-account", "profile")).toBeUndefined();
  });

  it("keeps caches for different profiles separate", () => {
    saveAccountModelCache("codex-cli-account", "profile-a", [model]);
    expect(
      loadAccountModelCache("codex-cli-account", "profile-b"),
    ).toBeUndefined();
    expect(loadAccountModelCache("codex-cli-account", "profile-a")).toEqual([
      model,
    ]);
  });
});
