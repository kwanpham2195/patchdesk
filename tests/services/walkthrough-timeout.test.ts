import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  readWalkthroughArtifactSizes,
  walkthroughTimeoutMs,
} from "../../src/services/walkthrough-timeout";

const roots: string[] = [];
afterEach(async () =>
  Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  ),
);

describe("walkthroughTimeoutMs", () => {
  it("keeps the five-minute floor for an empty patch", () => {
    expect(
      walkthroughTimeoutMs({ patchBytes: 0, contextBytes: 0, hunkCount: 0 }),
    ).toBe(5 * 60_000);
  });

  it("adds one minute for every eight hunks", () => {
    expect(
      walkthroughTimeoutMs({ patchBytes: 0, contextBytes: 0, hunkCount: 17 }),
    ).toBe(8 * 60_000);
  });

  it("adds one minute for every 256 KiB of artifacts", () => {
    expect(
      walkthroughTimeoutMs({
        patchBytes: 512 * 1024,
        contextBytes: 1,
        hunkCount: 0,
      }),
    ).toBe(8 * 60_000);
  });

  it("caps the bound at twenty minutes", () => {
    expect(
      walkthroughTimeoutMs({
        patchBytes: 64 * 1024 * 1024,
        contextBytes: 0,
        hunkCount: 4_096,
      }),
    ).toBe(20 * 60_000);
  });
});

describe("readWalkthroughArtifactSizes", () => {
  it("reports artifact bytes and the unified-diff hunk count", async () => {
    const root = await mkdtemp(join(tmpdir(), "patchdesk-walkthrough-sizes-"));
    roots.push(root);
    const patchPath = join(root, "patch.diff");
    const contextPath = join(root, "context.json");
    const patch = [
      "diff --git a/a.ts b/a.ts",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -1,1 +1,2 @@",
      "+first",
      "@@ -10,1 +11,2 @@",
      "+second",
      "",
    ].join("\n");
    await Promise.all([
      writeFile(patchPath, patch, "utf8"),
      writeFile(contextPath, "{}", "utf8"),
    ]);
    await expect(
      readWalkthroughArtifactSizes({ contextPath, patchPath }),
    ).resolves.toEqual({
      patchBytes: Buffer.byteLength(patch, "utf8"),
      contextBytes: 2,
      hunkCount: 2,
    });
  });
});
