import {
  OPENCODE_CLASSIFIER_MODELS,
  OPENCODE_MODELS,
} from "@earendil-works/pi-ai/providers/opencode.models";
import {
  OPENROUTER_CLASSIFIER_MODELS,
  OPENROUTER_IMAGE_MODELS,
  OPENROUTER_MODELS,
} from "@earendil-works/pi-ai/providers/openrouter.models";
import {
  VERCEL_AI_GATEWAY_CLASSIFIER_MODELS,
  VERCEL_AI_GATEWAY_MODELS,
} from "@earendil-works/pi-ai/providers/vercel-ai-gateway.models";
import { describe, expect, it } from "vitest";

import { generateModelCatalog } from "../scripts/generate-model-catalog.mjs";

describe("generated Pi catalog", () => {
  it("imports and projects all 32 current allowlisted provider catalogs deterministically", () => {
    const first = generateModelCatalog();
    expect(first).toEqual(generateModelCatalog());
    expect(first.piVersion).toBe("0.99.2");
    expect(first.catalog).toHaveLength(32);
    expect(
      first.catalog
        .flatMap((entry) => entry.models)
        .every((model) =>
          ["id,name,provider", "cost,id,name,provider"].includes(
            Object.keys(model).sort().join(","),
          ),
        ),
    ).toBe(true);
    expect(first.digest).toMatch(/^[a-f0-9]{64}$/);
  });

  it("keeps Pi's image and classifier models out of the run dialog catalog", () => {
    // Pi's provider data also holds image and classifier entries; the run dialog can only run chat models.
    const nonChat = [
      ["openrouter", OPENROUTER_MODELS, OPENROUTER_IMAGE_MODELS],
      ["openrouter", OPENROUTER_MODELS, OPENROUTER_CLASSIFIER_MODELS],
      ["opencode", OPENCODE_MODELS, OPENCODE_CLASSIFIER_MODELS],
      [
        "vercel-ai-gateway",
        VERCEL_AI_GATEWAY_MODELS,
        VERCEL_AI_GATEWAY_CLASSIFIER_MODELS,
      ],
    ] as const;
    const listed = new Set(
      generateModelCatalog().catalog.flatMap((entry) =>
        entry.models.map((model) => `${entry.provider}/${model.id}`),
      ),
    );
    const nonChatOnly = nonChat.flatMap(([provider, chat, other]) =>
      Object.keys(other)
        .filter((id) => !(id in chat))
        .map((id) => `${provider}/${id}`),
    );

    expect(nonChatOnly.length).toBeGreaterThan(0);
    expect(nonChatOnly.filter((id) => listed.has(id))).toEqual([]);
  });
});
