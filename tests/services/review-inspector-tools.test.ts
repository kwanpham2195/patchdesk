import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { ReviewInspector } from "../../src/services/review-inspector";
import { createReviewInspectorTools } from "../../src/services/review-inspector-tools";

describe("review inspector Flue tools", () => {
  it("exposes only the four session-scoped read operations", async () => {
    const root = await mkdtemp(join(tmpdir(), "patchdesk-inspector-tools-"));
    try {
      await mkdir(join(root, "src"));
      await writeFile(join(root, "src", "review.ts"), "first\nsecond\n", "utf8");
      const tools = createReviewInspectorTools(new ReviewInspector({
        worktreePath: root,
        changedFiles: ["src/review.ts"],
        gitShow: async () => "commit subject",
      }));

      expect(tools.map((tool) => tool.name)).toEqual([
        "list_changed_files",
        "search_files",
        "read_file_range",
        "git_show",
      ]);
      await expect(tools[0]?.run({ input: {} })).resolves.toEqual({ files: ["src/review.ts"] });
      await expect(tools[2]?.run({ input: { path: "src/review.ts", startLine: 2, endLine: 2 } })).resolves.toEqual({ content: "second" });
      await expect(tools[2]?.run({ input: { path: "../outside", startLine: 1, endLine: 1 } })).resolves.toEqual({ denied: true });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
