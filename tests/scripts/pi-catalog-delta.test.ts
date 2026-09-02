import { describe, expect, it } from "vitest";

import { diffCatalogs } from "../../scripts/pi-catalog-delta.mjs";

const model = (id: string, name: string, provider: string) =>
  `  { id: "${id}", name: "${name}", provider: "${provider}" },`;

const oldCatalog = [
  'export const piAiCatalog = { piVersion: "0.84.3", models: [',
  model("claude-sonnet-4-5", "Claude Sonnet 4.5", "anthropic"),
  model("gpt-4-turbo", "GPT-4 Turbo", "openai"),
  model("anthropic-claude-3-7", "Claude 3.7", "cloudflare-ai-gateway"),
  "] };",
].join("\n");

const newCatalog = [
  'export const piAiCatalog = { piVersion: "0.84.4", models: [',
  model("claude-sonnet-4-5", "Claude Sonnet 4.5", "anthropic"),
  model("claude-opus-4-1", "Claude Opus 4.1", "anthropic"),
  model("anthropic.claude-3-7", "Claude 3.7", "cloudflare-ai-gateway"),
  "] };",
].join("\n");

describe("diffCatalogs", () => {
  it("reports an id the new catalog gained", () => {
    const delta = diffCatalogs(oldCatalog, newCatalog);

    expect(delta.oldVersion).toBe("0.84.3");
    expect(delta.newVersion).toBe("0.84.4");
    expect(delta.added).toContain("anthropic/claude-opus-4-1");
    expect(delta.providerChanges).toContainEqual({
      provider: "anthropic",
      before: 1,
      after: 2,
    });
  });

  it("reports an id the new catalog dropped", () => {
    const delta = diffCatalogs(oldCatalog, newCatalog);

    expect(delta.removed).toContain("openai/gpt-4-turbo");
    expect(delta.providerChanges).toContainEqual({
      provider: "openai",
      before: 1,
      after: 0,
    });
  });

  it("pairs a removed id with the added id that only changed scheme", () => {
    const delta = diffCatalogs(oldCatalog, newCatalog);

    expect(delta.moves).toEqual([
      {
        from: "cloudflare-ai-gateway/anthropic-claude-3-7",
        to: "cloudflare-ai-gateway/anthropic.claude-3-7",
      },
    ]);
  });
});
