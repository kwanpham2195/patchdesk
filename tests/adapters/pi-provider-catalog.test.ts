import { describe, expect, it } from "vitest";

import { LocalPiProviderCatalog } from "../../src/adapters/pi/pi-provider-catalog";

function catalog(
  values: Record<string, string | undefined>,
  files: string[] = [],
) {
  return new LocalPiProviderCatalog({
    environment: (name) => values[name],
    homeDirectory: "/home/test",
    fileExists: async (path) => files.includes(path),
  });
}

describe("LocalPiProviderCatalog", () => {
  it.each([
    ["OPENAI_API_KEY", "openai", "OPENAI_API_KEY"],
    ["ANTHROPIC_API_KEY", "anthropic", "ANTHROPIC_API_KEY"],
    ["OPENROUTER_API_KEY", "openrouter", "OPENROUTER_API_KEY"],
  ])("reports %s without exposing its value", async (key, provider, source) => {
    const result = await catalog({ [key]: "secret-value" }).get();
    expect(result).toMatchObject({ _tag: "ok", value: { configured: true } });
    if (result._tag === "ok") {
      const status = result.value.providers.find(
        (entry) => entry.id === provider,
      );
      expect(status).toMatchObject({ configured: true, source });
      expect(JSON.stringify(status)).not.toContain("secret-value");
    }
  });

  it("requires both AWS credentials and identifies ambient Bedrock safely", async () => {
    const missing = await catalog({ AWS_ACCESS_KEY_ID: "only-one" }).get();
    expect(
      missing._tag === "ok" &&
        missing.value.providers.find((entry) => entry.id === "amazon-bedrock")
          ?.configured,
    ).toBe(false);
    const configured = await catalog({
      AWS_ACCESS_KEY_ID: "key",
      AWS_SECRET_ACCESS_KEY: "secret",
    }).get();
    expect(
      configured._tag === "ok" &&
        configured.value.providers.find(
          (entry) => entry.id === "amazon-bedrock",
        ),
    ).toMatchObject({ configured: true, source: "AWS credentials" });
  });

  it.each([
    ["missing project", { GOOGLE_CLOUD_LOCATION: "asia-southeast1" }, []],
    ["missing location", { GOOGLE_CLOUD_PROJECT: "project" }, []],
    [
      "missing credentials file",
      {
        GOOGLE_CLOUD_PROJECT: "project",
        GOOGLE_CLOUD_LOCATION: "asia-southeast1",
      },
      [],
    ],
    [
      "complete ADC",
      {
        GOOGLE_CLOUD_PROJECT: "project",
        GOOGLE_CLOUD_LOCATION: "asia-southeast1",
      },
      ["/home/test/.config/gcloud/application_default_credentials.json"],
    ],
  ])(
    "checks every Vertex ADC requirement: %s",
    async (_name, values, files) => {
      const result = await catalog(values, files).get();
      expect(
        result._tag === "ok" &&
          result.value.providers.find((entry) => entry.id === "google-vertex")
            ?.configured,
      ).toBe(files.length > 0);
    },
  );

  it("accepts Google Vertex with an API key without ADC", async () => {
    const result = await catalog({
      GOOGLE_CLOUD_API_KEY: "vertex-secret",
    }).get();
    expect(
      result._tag === "ok" &&
        result.value.providers.find((entry) => entry.id === "google-vertex"),
    ).toMatchObject({ configured: true, source: "GOOGLE_CLOUD_API_KEY" });
    expect(JSON.stringify(result)).not.toContain("vertex-secret");
  });

  it.each([
    [
      "API key",
      { CLOUDFLARE_ACCOUNT_ID: "account", CLOUDFLARE_GATEWAY_ID: "gateway" },
    ],
    [
      "account ID",
      { CLOUDFLARE_API_KEY: "api-secret", CLOUDFLARE_GATEWAY_ID: "gateway" },
    ],
    [
      "gateway ID",
      { CLOUDFLARE_API_KEY: "api-secret", CLOUDFLARE_ACCOUNT_ID: "account" },
    ],
  ])(
    "requires every Cloudflare AI Gateway field (missing %s)",
    async (_name, values) => {
      const result = await catalog(values).get();
      expect(
        result._tag === "ok" &&
          result.value.providers.find(
            (entry) => entry.id === "cloudflare-ai-gateway",
          )?.configured,
      ).toBe(false);
    },
  );

  it("reports Cloudflare AI Gateway when all required fields are present", async () => {
    const result = await catalog({
      CLOUDFLARE_API_KEY: "api-secret",
      CLOUDFLARE_ACCOUNT_ID: "account-secret",
      CLOUDFLARE_GATEWAY_ID: "gateway-secret",
    }).get();
    expect(
      result._tag === "ok" &&
        result.value.providers.find(
          (entry) => entry.id === "cloudflare-ai-gateway",
        ),
    ).toMatchObject({ configured: true, source: "CLOUDFLARE_API_KEY" });
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  it("keeps every provider status bounded and redacted", async () => {
    const result = await catalog({}).get();
    expect(result._tag).toBe("ok");
    if (result._tag === "ok") {
      expect(result.value.providers.length).toBeLessThanOrEqual(64);
      expect(
        result.value.providers.every(
          (entry) => entry.source === undefined || !entry.source.includes("/"),
        ),
      ).toBe(true);
      expect(
        result.value.providers.find((entry) => entry.id === "openai-codex"),
      ).toBeUndefined();
      expect(
        result.value.providers.find((entry) => entry.id === "github-copilot"),
      ).toBeUndefined();
    }
  });
});

describe("provider environment allowlist", () => {
  it("exposes only the selected provider credential names", async () => {
    const { providerEnvironmentNames } =
      await import("../../src/adapters/pi/pi-provider-catalog");
    expect(providerEnvironmentNames("deepseek")).toEqual(["DEEPSEEK_API_KEY"]);
    expect(providerEnvironmentNames("amazon-bedrock")).toContain(
      "AWS_WEB_IDENTITY_TOKEN_FILE",
    );
    expect(providerEnvironmentNames("google-vertex")).toContain(
      "GOOGLE_APPLICATION_CREDENTIALS",
    );
    expect(providerEnvironmentNames("deepseek")).not.toContain("GH_TOKEN");
    expect(providerEnvironmentNames("unknown")).toEqual([]);
  });

  it("keeps the ambient environment table readonly at both levels", async () => {
    const { AMBIENT_ENVIRONMENT } =
      await import("../../src/adapters/pi/pi-provider-catalog");
    const table: typeof AMBIENT_ENVIRONMENT = { bedrock: [], vertex: [] };

    // A compile-time probe, not a runtime one. Both directives below must
    // keep firing: annotate `AMBIENT_ENVIRONMENT` with anything that is not
    // readonly at both levels -- a trailing `satisfies` on its own is the easy
    // mistake -- and they go unused, which fails `pnpm typecheck`.
    // @ts-expect-error `bedrock` is a readonly property.
    table.bedrock = [];
    // @ts-expect-error entries are `ReadonlyArray<string>`, so they cannot be pushed to.
    table.vertex.push("AWS_REGION");

    expect(AMBIENT_ENVIRONMENT.bedrock).toContain("AWS_ACCESS_KEY_ID");
    expect(AMBIENT_ENVIRONMENT.vertex).toContain("GOOGLE_CLOUD_PROJECT");
  });
});
