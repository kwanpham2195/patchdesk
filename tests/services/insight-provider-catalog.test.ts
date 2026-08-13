import { describe, expect, it } from "vitest";

import { InsightProviderCatalog } from "../../src/services/insight-provider-catalog";
import { ok } from "../../src/domain/result";
import type { CodexAppServerClient } from "../../src/adapters/codex/codex-app-server-client";
import type { PiRuntimeModelCatalog } from "../../src/adapters/pi/pi-runtime-model-catalog";

const pi: PiRuntimeModelCatalog = {
  async get() {
    return ok({ models: [{ id: "openai/gpt", label: "GPT" }] });
  },
};

const codexModels = [
  {
    id: "codex-model",
    label: "Codex model",
    reasoning: ["low", "high"] as const,
    defaultReasoning: "low" as const,
  },
];

describe("InsightProviderCatalog", () => {
  it("reports Codex passively without constructing or invoking an app server", async () => {
    let constructed = 0;
    const catalog = new InsightProviderCatalog(
      pi,
      () => {
        constructed += 1;
        throw new Error("Codex must not start during passive status");
      },
      async () => "/usr/local/bin/codex",
    );
    await expect(catalog.passive()).resolves.toEqual({
      _tag: "ok",
      value: {
        providers: [
          {
            id: "pi",
            label: "Pi",
            available: true,
            guidance:
              "Configure an eligible Pi provider in the Electron process.",
          },
          {
            id: "codex-cli-account",
            label: "Codex CLI account",
            available: true,
            guidance: "Use the existing local Codex CLI login.",
          },
        ],
        models: [
          {
            provider: "pi",
            id: "openai/gpt",
            label: "GPT",
            reasoning: ["low", "medium", "high"],
            defaultReasoning: "medium",
          },
        ],
      },
    });
    expect(constructed).toBe(0);
  });

  it("loads live Codex models only through explicit activation and validates exact choices", async () => {
    let listed = 0;
    const client = {
      async listModels() {
        listed += 1;
        return ok(codexModels);
      },
    } as unknown as CodexAppServerClient;
    const catalog = new InsightProviderCatalog(
      pi,
      () => client,
      async () => "/usr/local/bin/codex",
    );
    expect(listed).toBe(0);
    await expect(catalog.activateCodex()).resolves.toEqual({
      _tag: "ok",
      value: {
        providers: [
          {
            id: "codex-cli-account",
            label: "Codex CLI account",
            available: true,
            guidance: "Use the existing local Codex CLI login.",
          },
        ],
        models: [{ provider: "codex-cli-account", ...codexModels[0] }],
      },
    });
    expect(listed).toBe(1);
    await expect(
      catalog.validate({
        provider: "codex-cli-account",
        model: "codex-model",
        reasoning: "low",
      }),
    ).resolves.toEqual({ _tag: "ok", value: undefined });
    await expect(
      catalog.validate({
        provider: "codex-cli-account",
        model: "other",
        reasoning: "low",
      }),
    ).resolves.toEqual({ _tag: "err", error: "model_unavailable" });
  });
});
