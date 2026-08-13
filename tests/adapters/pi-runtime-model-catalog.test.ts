import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { LocalPiProviderCatalog } from "../../src/adapters/pi/pi-provider-catalog";

it("parses the generated isolated Pi catalog and exposes only its safe projection", async () => {
  const { PI_AI_CATALOG } = await import("../../src/adapters/pi/pi-ai-catalog");
  expect(PI_AI_CATALOG).toHaveLength(32);
  expect(PI_AI_CATALOG.find((entry) => entry.provider === "openai")?.models.some((model) => model.id === "gpt-4-turbo")).toBe(true);
  expect(JSON.stringify(PI_AI_CATALOG)).not.toContain("apiKey");
});
import { LocalPiRuntimeModelCatalog, canonicalModelId } from "../../src/adapters/pi/pi-runtime-model-catalog";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function fixture(settings: unknown, environment: Record<string, string | undefined>) {
  const root = await mkdtemp(join(tmpdir(), "patchdesk-pi-catalog-")); roots.push(root);
  const settingsPath = join(root, "settings.json");
  await mkdir(root, { recursive: true });
  await writeFile(settingsPath, JSON.stringify(settings), "utf8");
  return new LocalPiRuntimeModelCatalog(settingsPath, new LocalPiProviderCatalog({ environment: (name) => environment[name], homeDirectory: root, fileExists: async () => false }));
}

describe("LocalPiRuntimeModelCatalog", () => {
  it("canonicalizes, orders preferences, deduplicates, and filters configured models", async () => {
    const catalog = await fixture({ enabledModels: ["custom/model", "OPENAI/gpt-5", "openai/gpt-5", "openai/gpt-4", "openai/gpt/invalid", "openai-codex/gpt-5"], defaultModel: "openai/gpt-4" }, { OPENAI_API_KEY: "secret" });
    const result = await catalog.get();
    expect(result._tag).toBe("ok");
    if (result._tag === "ok") {
      expect(result.value.defaultModel).toBe("openai/gpt-4");
      expect(result.value.models.slice(0, 2).map((model) => model.id)).toEqual(["openai/gpt-4", "openai/gpt-5"]);
      expect(result.value.models.some((model) => model.id === "openai/gpt-4-turbo")).toBe(true);
      expect(result.value.models.some((model) => model.id.startsWith("openai-codex/") || model.id.startsWith("custom/") || model.id === "openai/gpt/invalid")).toBe(false);
    }
  });

  it("includes a catalog model outside Pi enabledModels when its provider is configured", async () => {
    const catalog = await fixture({ enabledModels: ["openai/gpt-5"] }, { OPENAI_API_KEY: "secret" });
    const result = await catalog.get();
    expect(result._tag === "ok" && result.value.models.some((model) => model.id === "openai/gpt-4-turbo")).toBe(true);
  });

  it("enumerates the catalog when Pi settings are absent", async () => {
    const root = await mkdtemp(join(tmpdir(), "patchdesk-pi-catalog-")); roots.push(root);
    const catalog = new LocalPiRuntimeModelCatalog(join(root, "missing-settings.json"), new LocalPiProviderCatalog({
      environment: (name) => name === "OPENAI_API_KEY" ? "secret" : undefined,
      homeDirectory: root,
      fileExists: async () => false,
    }));
    const result = await catalog.get();
    expect(result._tag === "ok" && result.value.models.some((model) => model.id === "openai/gpt-4-turbo")).toBe(true);
  });

  it("keeps OAuth and Workers providers out of the universal catalog", async () => {
    const catalog = await fixture({ enabledModels: ["openai-codex/gpt-5", "cloudflare-workers-ai/@cf/meta/llama-3"] }, { OPENAI_API_KEY: "secret" });
    const result = await catalog.get();
    expect(result._tag).toBe("ok");
    if (result._tag === "ok") {
      expect(result.value.models.some((model) => model.id.startsWith("openai-codex/") || model.id.startsWith("cloudflare-workers-ai/"))).toBe(false);
    }
  });

  it("returns a redacted empty state when no provider is configured", async () => {
    const catalog = await fixture({ enabledModels: ["openai/gpt-5"] }, {});
    const result = await catalog.get();
    expect(result).toMatchObject({ _tag: "ok", value: { models: [], configured: false } });
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  it("rejects malformed and OAuth identifiers", () => {
    expect(canonicalModelId("openai/gpt-5")).toBe("openai/gpt-5");
    expect(canonicalModelId("OPENAI/gpt-5")).toBe("openai/gpt-5");
    expect(canonicalModelId("openrouter/anthropic/claude-sonnet-4")).toBe("openrouter/anthropic/claude-sonnet-4");
    expect(canonicalModelId("openai-codex/gpt-5")).toBeUndefined();
    expect(canonicalModelId("custom/provider/model")).toBeUndefined();
    expect(canonicalModelId("openai/")).toBeUndefined();
  });
});
