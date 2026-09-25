import { describe, expect, it } from "vitest";

import { generateModelCatalog } from "../scripts/generate-model-catalog.mjs";

describe("generated Pi catalog", () => {
  it("imports and projects all 32 current allowlisted provider catalogs deterministically", () => {
    const first = generateModelCatalog();
    expect(first).toEqual(generateModelCatalog());
    expect(first.piVersion).toBe("0.87.1");
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
});
