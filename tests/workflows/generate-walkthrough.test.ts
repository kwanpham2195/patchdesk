import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { readBoundedArtifact } from "../../src/workflows/walkthrough-artifact-reader";
import {
  parseWalkthroughOutput,
  runWalkthroughWorkflow,
  walkthroughOutputSchema,
} from "../../src/workflows/generate-walkthrough";
import * as v from "valibot";

const validOutput = {
  title: "Recovery walkthrough",
  focus: "Follow the recovery decision.",
  chapters: [{
    title: "Recovery",
    sections: [{
      title: "One action",
      prose: "The projection selects one action.",
      hunkIds: ["h1"],
    }],
  }],
};
const baseChapter = validOutput.chapters[0];
if (baseChapter === undefined) throw new Error("test fixture chapter missing");
const baseSection = baseChapter.sections[0];
if (baseSection === undefined) throw new Error("test fixture section missing");

describe("walkthrough artifact boundary", () => {
  it("reads a bounded artifact without materializing an oversized file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "patchdesk-walkthrough-"));
    const path = join(directory, "patch.diff");
    await writeFile(path, "0123456789", "utf8");

    try {
      await expect(readBoundedArtifact(path, 10)).resolves.toEqual({ _tag: "ok", value: "0123456789" });
      await expect(readBoundedArtifact(path, 9)).resolves.toEqual({
        _tag: "err",
        error: { reason: "input_too_large" },
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("walkthrough raw output boundary", () => {
  it("rejects aggregate overflow at the workflow output schema boundary", () => {
    const chapters = Array.from({ length: 2 }, (_, chapterIndex) => ({
      title: `Chapter ${chapterIndex}`,
      sections: Array.from({ length: 17 }, (_, sectionIndex) => ({
        title: `Section ${chapterIndex}-${sectionIndex}`,
        prose: "A bounded explanation.",
        hunkIds: ["h1"],
      })),
    }));
    expect(v.safeParse(walkthroughOutputSchema, { ...validOutput, chapters }).success).toBe(false);
  });

  it("rejects valid JSON with a wrong shape or extra keys", () => {
    expect(parseWalkthroughOutput({ ...validOutput, unexpected: true })).toEqual({
      _tag: "err",
      error: { _tag: "InvalidWalkthroughOutput" },
    });
    expect(parseWalkthroughOutput({ title: "missing" })).toEqual({
      _tag: "err",
      error: { _tag: "InvalidWalkthroughOutput" },
    });
  });

  it("rejects oversized prose, invalid aliases, and aggregate section overflow", () => {
    const oversized = {
      ...validOutput,
      chapters: [{
        ...baseChapter,
        sections: [{
          ...baseSection,
          prose: "x".repeat(4_001),
        }],
      }],
    };
    expect(parseWalkthroughOutput(oversized)).toEqual({
      _tag: "err",
      error: { _tag: "InvalidWalkthroughOutput" },
    });

    expect(parseWalkthroughOutput({
      ...validOutput,
      chapters: [{
        ...baseChapter,
        sections: [{ ...baseSection, hunkIds: ["h12345678901234567"] }],
      }],
    })).toEqual({ _tag: "err", error: { _tag: "InvalidWalkthroughOutput" } });

    const chapters = Array.from({ length: 2 }, (_, chapterIndex) => ({
      title: `Chapter ${chapterIndex}`,
      sections: Array.from({ length: 17 }, (_, sectionIndex) => ({
        title: `Section ${chapterIndex}-${sectionIndex}`,
        prose: "A bounded explanation.",
        hunkIds: ["h1"],
      })),
    }));
    expect(parseWalkthroughOutput({ ...validOutput, chapters })).toEqual({
      _tag: "err",
      error: { _tag: "InvalidWalkthroughOutput" },
    });
  });
});

describe("walkthrough workflow harness contract", () => {
  it("forwards explicit choices and keeps generation read-only with no tools", async () => {
    const directory = await mkdtemp(join(tmpdir(), "patchdesk-walkthrough-harness-"));
    const contextPath = join(directory, "context.json");
    const patchPath = join(directory, "patch.diff");
    const prompts: Array<{ text: string; options: { model?: string; thinkingLevel?: string; tools: ReadonlyArray<unknown> } }> = [];
    await writeFile(contextPath, "context artifact", "utf8");
    await writeFile(patchPath, "@@ -1,1 +1,1 @@\n-old\n+new\n", "utf8");

    try {
      const result = await runWalkthroughWorkflow({
        input: {
          profileId: "profile-1",
          sessionId: "session-1",
          contextPath,
          patchPath,
          model: "model-explicit",
          reasoning: "high",
        },
        harness: {
          session: async () => ({
            prompt: async <T>(text: string, options: { model?: string; thinkingLevel?: string; tools: ReadonlyArray<unknown> }) => {
              prompts.push({ text, options });
              return { data: validOutput as T };
            },
          }),
        },
      });

      expect(result).toEqual(validOutput);
      expect(prompts).toHaveLength(1);
      const prompt = prompts[0];
      if (prompt === undefined) throw new Error("workflow prompt missing");
      expect(prompt.options.model).toBe("model-explicit");
      expect(prompt.options.thinkingLevel).toBe("high");
      expect(prompt.options.tools).toEqual([]);
      expect(prompt.text).toContain("ordered chapter rail");
      expect(prompt.text).toContain("continuous reading surface");
      expect(prompt.text).toContain("behavior before consequences and validation");
      expect(prompt.text).toContain("hunk aliases h1, h2, h3");
      expect(prompt.text).toContain("Support");
      expect(prompt.text).toContain("context artifact");
      expect(prompt.text).toContain("@@ -1,1 +1,1 @@");
      expect(prompt.text).not.toMatch(/review completion|review failure|workflow:review-pr|commenting|persist(?:ence|ed|ing)/i);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
