import { describe, expect, it } from "vitest";

import { InsightProviderCatalog } from "../../src/services/insight-provider-catalog";
import { err, ok } from "../../src/domain/result";
import type { CodexAppServerClient } from "../../src/adapters/codex/codex-app-server-client";
import type { PiRpcClient } from "../../src/adapters/pi-cli/pi-rpc-client";
import type { PiRuntimeModelCatalog } from "../../src/adapters/pi/pi-runtime-model-catalog";

const pi: PiRuntimeModelCatalog = {
  async get() {
    return ok({
      models: [
        { id: "openai/gpt", label: "GPT", cost: { input: 1.25, output: 10 } },
      ],
    });
  },
};

const unconfiguredPi: PiRuntimeModelCatalog = {
  async get() {
    return err({ _tag: "PiRuntimeModelCatalogUnavailable" });
  },
};

const noCodex = async (): Promise<undefined> => undefined;

const piCliMustNotStart = (): Pick<PiRpcClient, "listModels"> => {
  throw new Error("pi must not start in this test");
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
      piCliMustNotStart,
      async () => "/usr/local/bin/codex",
    );
    await expect(catalog.passive()).resolves.toEqual({
      _tag: "ok",
      value: {
        providers: [
          {
            id: "pi",
            label: "API key",
            available: true,
            guidance:
              "Export a provider key such as ANTHROPIC_API_KEY in your shell profile, then relaunch Patchdesk.",
          },
          {
            id: "codex-cli-account",
            label: "Codex CLI account",
            available: true,
            guidance: "Use the existing local Codex CLI login.",
          },
          {
            id: "pi-cli-account",
            label: "pi CLI account",
            available: true,
            guidance: "Use the existing local pi login.",
          },
        ],
        models: [
          {
            provider: "pi",
            id: "openai/gpt",
            label: "GPT",
            reasoning: ["low", "medium", "high"],
            defaultReasoning: "medium",
            cost: { input: 1.25, output: 10 },
          },
        ],
      },
    });
    expect(constructed).toBe(0);
  });

  it("loads live Codex models only through explicit activation and validates exact choices", async () => {
    let listed = 0;
    const client: Pick<CodexAppServerClient, "listModels"> = {
      async listModels() {
        listed += 1;
        return ok(codexModels);
      },
    };
    const catalog = new InsightProviderCatalog(
      pi,
      () => client,
      piCliMustNotStart,
      async () => "/usr/local/bin/codex",
    );
    expect(listed).toBe(0);
    await expect(catalog.activateAccount("codex-cli-account")).resolves.toEqual(
      {
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
      },
    );
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

  it("preserves cancellation separately from runtime failures", async () => {
    const catalogueFor = (reason: "cancelled" | "runtime_unavailable") =>
      new InsightProviderCatalog(
        pi,
        () => ({
          async listModels() {
            return err({ reason, phase: "model_list" as const });
          },
        }),
        piCliMustNotStart,
        async () => "/usr/local/bin/codex",
      );

    await expect(
      catalogueFor("cancelled").activateAccount("codex-cli-account"),
    ).resolves.toEqual({
      _tag: "err",
      error: {
        _tag: "InsightProviderCatalogUnavailable",
        reason: "cancelled",
      },
    });
    await expect(
      catalogueFor("runtime_unavailable").activateAccount("codex-cli-account"),
    ).resolves.toEqual({
      _tag: "err",
      error: {
        _tag: "InsightProviderCatalogUnavailable",
        reason: "runtime_unavailable",
      },
    });
  });

  it("lists no models for either provider when neither source can list", async () => {
    const catalog = new InsightProviderCatalog(
      unconfiguredPi,
      () => {
        throw new Error("Codex must not start during passive status");
      },
      piCliMustNotStart,
      noCodex,
    );
    await expect(catalog.passive()).resolves.toEqual({
      _tag: "ok",
      value: {
        providers: [
          {
            id: "pi",
            label: "API key",
            available: false,
            guidance:
              "Export a provider key such as ANTHROPIC_API_KEY in your shell profile, then relaunch Patchdesk.",
          },
          {
            id: "codex-cli-account",
            label: "Codex CLI account",
            available: false,
            guidance:
              "Install Codex and expose codex on the app launch PATH, then log in externally.",
          },
          {
            id: "pi-cli-account",
            label: "pi CLI account",
            available: false,
            guidance:
              "Install pi and expose pi on the app launch PATH, then log in externally.",
          },
        ],
        models: [],
      },
    });
  });

  it("validates a Pi choice against the source the Pi listing came from", async () => {
    const catalog = new InsightProviderCatalog(
      pi,
      () => {
        throw new Error("Codex must not start for a Pi selection");
      },
      piCliMustNotStart,
      noCodex,
    );
    await expect(
      catalog.validate({
        provider: "pi",
        model: "openai/gpt",
        reasoning: "medium",
      }),
    ).resolves.toEqual({ _tag: "ok", value: undefined });
    await expect(
      catalog.validate({
        provider: "pi",
        model: "openai/absent",
        reasoning: "medium",
      }),
    ).resolves.toEqual({ _tag: "err", error: "model_unavailable" });
    await expect(
      catalog.validate({
        provider: "pi",
        model: "openai/gpt",
        reasoning: "xhigh",
      }),
    ).resolves.toEqual({ _tag: "err", error: "model_unavailable" });
  });

  it("separates a source that cannot list from a model that is missing", async () => {
    const catalog = new InsightProviderCatalog(
      unconfiguredPi,
      () => {
        throw new Error("Codex must not start without an executable");
      },
      piCliMustNotStart,
      noCodex,
    );
    await expect(
      catalog.validate({
        provider: "pi",
        model: "openai/gpt",
        reasoning: "medium",
      }),
    ).resolves.toEqual({ _tag: "err", error: "catalog_unavailable" });
    await expect(
      catalog.validate({
        provider: "codex-cli-account",
        model: "codex-model",
        reasoning: "low",
      }),
    ).resolves.toEqual({ _tag: "err", error: "catalog_unavailable" });
    await expect(catalog.activateAccount("codex-cli-account")).resolves.toEqual(
      {
        _tag: "err",
        error: {
          _tag: "InsightProviderCatalogUnavailable",
          reason: "runtime_unavailable",
        },
      },
    );
  });

  it("loads pi CLI account models only through explicit activation and validates exact choices", async () => {
    const resolved: string[] = [];
    let listed = 0;
    const catalog = new InsightProviderCatalog(
      pi,
      () => {
        throw new Error("Codex must not start for a pi selection");
      },
      () => ({
        async listModels() {
          listed += 1;
          return ok([
            {
              id: "anthropic/claude-sonnet-5",
              label: "anthropic/claude-sonnet-5",
              reasoning: ["low", "medium", "high"] as const,
              defaultReasoning: "medium" as const,
            },
          ]);
        },
      }),
      async (name) => {
        resolved.push(name);
        return `/usr/local/bin/${name}`;
      },
    );
    await catalog.passive();
    expect(listed).toBe(0);
    await expect(catalog.activateAccount("pi-cli-account")).resolves.toEqual({
      _tag: "ok",
      value: {
        providers: [
          {
            id: "pi-cli-account",
            label: "pi CLI account",
            available: true,
            guidance: "Use the existing local pi login.",
          },
        ],
        models: [
          {
            provider: "pi-cli-account",
            id: "anthropic/claude-sonnet-5",
            label: "anthropic/claude-sonnet-5",
            reasoning: ["low", "medium", "high"],
            defaultReasoning: "medium",
          },
        ],
      },
    });
    expect(listed).toBe(1);
    expect(resolved).toContain("pi");
    await expect(
      catalog.validate({
        provider: "pi-cli-account",
        model: "anthropic/claude-sonnet-5",
        reasoning: "high",
      }),
    ).resolves.toEqual({ _tag: "ok", value: undefined });
    await expect(
      catalog.validate({
        provider: "pi-cli-account",
        model: "anthropic/claude-sonnet-5",
        reasoning: "xhigh",
      }),
    ).resolves.toEqual({ _tag: "err", error: "model_unavailable" });
  });

  it.each([
    {
      name: "a missing pi is runtime_unavailable",
      executable: undefined,
      failure: undefined,
      expected: { reason: "runtime_unavailable" },
    },
    {
      name: "a missing login is authentication_required",
      executable: "/usr/local/bin/pi",
      failure: { reason: "authentication_required", phase: "model_list" },
      expected: { reason: "authentication_required" },
    },
    {
      name: "an outdated pi is runtime_unavailable and names the version it needs",
      executable: "/usr/local/bin/pi",
      failure: {
        reason: "runtime_unavailable",
        phase: "version",
        requiredVersion: "0.80.4",
      },
      expected: { reason: "runtime_unavailable", requiredVersion: "0.80.4" },
    },
  ] as const)("$name", async ({ executable, failure, expected }) => {
    const catalog = new InsightProviderCatalog(
      pi,
      () => {
        throw new Error("Codex must not start for a pi selection");
      },
      () => ({
        async listModels() {
          return failure === undefined ? ok([]) : err(failure);
        },
      }),
      async () => executable,
    );
    await expect(catalog.activateAccount("pi-cli-account")).resolves.toEqual({
      _tag: "err",
      error: { _tag: "InsightProviderCatalogUnavailable", ...expected },
    });
  });
});
