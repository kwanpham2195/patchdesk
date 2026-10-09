import { buildGuideInventory } from "#src/domain/guide";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  prepareGuidePrompt,
  MAX_GUIDE_PROMPT_BYTES,
} from "#src/services/guide-operation";
import { must } from "./insight-run-fixture";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function artifacts(
  patch = "diff --git a/a.ts b/a.ts\nold mode 100644\nnew mode 100755\n",
  context = "Review evidence",
) {
  const root = await mkdtemp(join(tmpdir(), "guide-prompt-"));
  roots.push(root);
  const contextPath = join(root, "context");
  const patchPath = join(root, "patch");
  await Promise.all([
    writeFile(contextPath, context),
    writeFile(patchPath, patch),
  ]);
  return { contextPath, patchPath, language: "vi" as const };
}
describe("complete Guide preparation", () => {
  it("supplies exact inventory, complete evidence, selected language and strict schema", async () => {
    const result = must(await prepareGuidePrompt(await artifacts()));
    expect(result.prompt).toContain(
      "Generate a Guide for the PR reviewer from the supplied immutable patch.",
    );
    expect(result.prompt).toContain('BCP 47 tag "vi"');
    expect(result.prompt).toContain("INVENTORY:\n\n");
    expect(result.prompt).toContain('"id":"f1"');
    expect(result.prompt).toContain("REVIEW CONTEXT:\n\nReview evidence");
    expect(result.prompt).toContain("IMMUTABLE PATCH:\n\ndiff --git");
    expect(Buffer.byteLength(result.prompt)).toBeLessThanOrEqual(
      MAX_GUIDE_PROMPT_BYTES,
    );
  });
  it.each(["patch", "context"] as const)(
    "refuses oversized %s before producing a prompt",
    async (artifact) => {
      const input = await artifacts();
      await writeFile(
        artifact === "patch" ? input.patchPath : input.contextPath,
        Buffer.alloc((artifact === "patch" ? 2 * 1024 * 1024 : 512 * 1024) + 1),
      );
      expect(await prepareGuidePrompt(input)).toEqual({
        _tag: "err",
        error: { reason: "artifact_too_large", artifact },
      });
    },
  );
  it("refuses a complete serialized inventory over its byte limit", async () => {
    const patch = Array.from(
      { length: 4000 },
      (_, index) =>
        `diff --git a/${index}.ts b/${index}.ts\nold mode 100644\nnew mode 100755\n`,
    ).join("");
    expect(await prepareGuidePrompt(await artifacts(patch))).toEqual({
      _tag: "err",
      error: { reason: "inventory_too_large" },
    });
  });
  it("refuses the final assembled prompt when individually bounded inputs do not fit", async () => {
    const metadata = Array.from(
      { length: 2100 },
      (_, index) =>
        `diff --git a/${index}.ts b/${index}.ts\nold mode 100644\nnew mode 100755\n`,
    ).join("");
    const hunk = "@@ -0,0 +1 @@\n+";
    const inventory = must(buildGuideInventory(metadata));
    const paddingBytes =
      512 * 1024 - Buffer.byteLength(JSON.stringify(inventory)) - 10;
    const extraMetadata = `${"z".repeat(paddingBytes)}\n`;
    const patch = `${metadata}${extraMetadata}${hunk}${"x".repeat(2 * 1024 * 1024 - metadata.length - extraMetadata.length - hunk.length)}`;
    const result = await prepareGuidePrompt(
      await artifacts(patch, "c".repeat(512 * 1024)),
    );
    expect(result._tag).toBe("err");
    if (result._tag === "err")
      expect(result.error.reason).toBe("prompt_too_large");
  });
  it("refuses an empty patch", async () => {
    expect(await prepareGuidePrompt(await artifacts(""))).toEqual({
      _tag: "err",
      error: { reason: "patch_not_indexable" },
    });
  });
});
