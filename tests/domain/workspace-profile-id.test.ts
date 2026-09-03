import { describe, expect, it } from "vitest";

import { deriveWorkspaceProfileId } from "../../src/domain/ids";

const noneTaken: ReadonlySet<string> = new Set();

function derive(label: string, taken: ReadonlySet<string> = noneTaken): string {
  const derived = deriveWorkspaceProfileId(label, taken);
  if (derived._tag === "err") throw new Error("Expected a derived id");
  return derived.value;
}

describe("deriveWorkspaceProfileId", () => {
  it("lowercases the name and collapses every run of non-alphanumerics", () => {
    expect(derive("CFW")).toBe("cfw");
    expect(derive("Central   Digital / Platform")).toBe(
      "central-digital-platform",
    );
    expect(derive("  Work_2026!  ")).toBe("work-2026");
  });

  it("rejects a name with no alphanumeric character", () => {
    for (const label of ["", "   ", "···"])
      expect(deriveWorkspaceProfileId(label, noneTaken)).toMatchObject({
        _tag: "err",
        error: { field: "workspaceProfileId" },
      });
  });

  it("takes the first free numeric suffix on collision", () => {
    expect(derive("CFW", new Set(["cfw"]))).toBe("cfw-2");
    expect(derive("CFW", new Set(["cfw", "cfw-2"]))).toBe("cfw-3");
    expect(derive("CFW", new Set(["cfw-2"]))).toBe("cfw");
  });

  it("derives an id the workspace-profile parser accepts", () => {
    // The derived slug is what every profile path is built from, so it has to
    // clear the same parser an explicit id does.
    expect(derive("Work_2026!")).toMatch(/^[a-z0-9][a-z0-9-]*$/);
  });
});
