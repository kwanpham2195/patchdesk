import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { runModelReview, type ReviewModelSession } from "../../src/services/model-review-runner";

describe("model review runner", () => {
  it("passes prepared metadata and only the four inspector tools to a structured model operation", async () => {
    const root = await mkdtemp(join(tmpdir(), "patchdesk-model-review-"));
    try {
      await mkdir(join(root, "src"));
      await writeFile(join(root, "src", "review.ts"), "export const review = true;\n", "utf8");
      const contextPath = join(root, "context.json");
      const reviewInputPath = join(root, "review-input.md");
      await writeFile(contextPath, JSON.stringify({ pr: { title: "centraldigital/patchdesk#42", headSha: "abcdef" }, changedFiles: ["src/review.ts"], checks: { overall: "passing" } }), "utf8");
      await writeFile(reviewInputPath, "# PR review input\n\nPR: centraldigital/patchdesk#42\n", "utf8");
      let prompt = "";
      let toolNames: ReadonlyArray<string> = [];
      const session: ReviewModelSession = {
        async prompt(input, options) {
          prompt = input;
          toolNames = options.tools.map((tool) => tool.name);
          return { data: { changeSummary: "Review complete.", verdict: "comment" as const, summary: "One issue found.", findings: [], validationPlan: ["pnpm test"], assumptions: [] } };
        },
      };

      const result = await runModelReview({
        session,
        worktreePath: root,
        contextPath,
        reviewInputPath,
        debugPath: join(root, "debug.json"),
        gitShow: async () => "commit subject",
      });

      expect(result).toMatchObject({ verdict: "comment", findings: [] });
      expect(prompt).toContain("centraldigital/patchdesk#42");
      expect(prompt).not.toContain("export const review");
      expect(toolNames).toEqual(["list_changed_files", "search_files", "read_file_range", "git_show"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
