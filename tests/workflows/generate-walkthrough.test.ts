import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import * as v from "valibot";

import { readBoundedArtifact } from "../../src/services/walkthrough-artifact-reader";
import {
  parseWalkthroughOutput,
  prepareWalkthroughPrompt,
  walkthroughOutputSchema,
} from "../../src/services/walkthrough-operation";

const validOutput = {
  citationVersion: 2,
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
    await writeFile(path, "0123456789");
    try {
      await expect(readBoundedArtifact(path, 10)).resolves.toEqual({ _tag: "ok", value: "0123456789" });
      await expect(readBoundedArtifact(path, 9)).resolves.toEqual({ _tag: "err", error: { reason: "input_too_large" } });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("walkthrough raw output boundary", () => {
  it("rejects aggregate overflow at the output schema boundary", () => {
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

  it("rejects wrong shapes and extra keys", () => {
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
    expect(parseWalkthroughOutput({
      ...validOutput,
      chapters: [{
        ...baseChapter,
        sections: [{ ...baseSection, prose: "x".repeat(4_001) }],
      }],
    })).toEqual({ _tag: "err", error: { _tag: "InvalidWalkthroughOutput" } });
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

  it("bounds new prose and focus to the concise limit", () => {
    expect(v.safeParse(walkthroughOutputSchema, {
      ...validOutput,
      focus: "x".repeat(320),
      chapters: [{ ...baseChapter, sections: [{ ...baseSection, prose: "x".repeat(320) }] }],
    }).success).toBe(true);
    expect(v.safeParse(walkthroughOutputSchema, {
      ...validOutput,
      chapters: [{ ...baseChapter, sections: [{ ...baseSection, prose: "x".repeat(321) }] }],
    }).success).toBe(false);
    expect(v.safeParse(walkthroughOutputSchema, { ...validOutput, focus: "x".repeat(321) }).success).toBe(false);
  });
});

describe("walkthrough prompt preparation", () => {
  it("uses fixed bounded artifacts, explicit provenance, and no write instructions", async () => {
    const directory = await mkdtemp(join(tmpdir(), "patchdesk-walkthrough-prompt-"));
    const contextPath = join(directory, "context.json");
    const patchPath = join(directory, "patch.diff");
    await writeFile(contextPath, "context artifact");
    await writeFile(
      patchPath,
      "diff --git a/src/recovery.ts b/src/recovery.ts\n--- a/src/recovery.ts\n+++ b/src/recovery.ts\n@@ -1,1 +1,1 @@\n-old\n+new\n",
    );
    try {
      const prompt = await prepareWalkthroughPrompt({
        profileId: "profile-1",
        sessionId: "session-1",
        contextPath,
        patchPath,
        model: "model-explicit",
        reasoning: "high",
      });
      expect(prompt).toContain("ordered chapter rail");
      expect(prompt).toContain("continuous reading surface");
      expect(prompt).toContain("behavior before consequences and validation");
      expect(prompt).toContain("ASD-STE100 / Simplified Technical English");
      expect(prompt).toContain("Use short, direct sentences in the active voice");
      expect(prompt).toContain("Use an inverted pyramid");
      expect(prompt).toContain("Do not narrate the patch file by file");
      expect(prompt).toContain("Choose the smallest Markdown form");
      expect(prompt).toContain("Use a short paragraph for one connected idea");
      expect(prompt).toContain("renderer preserves it");
      expect(prompt).toContain("HUNK ALIAS MANIFEST");
      expect(prompt).toContain("h1 | src/recovery.ts | @@ -1,1 +1,1 @@");
      expect(prompt).toContain("citationVersion to 2");
      expect(prompt).toContain("Support");
      expect(prompt).toContain("context artifact");
      expect(prompt).not.toMatch(/review completion|review failure|workflow:review-pr|commenting|persist(?:ence|ed|ing)/i);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects an oversized artifact before composing model input", async () => {
    const directory = await mkdtemp(join(tmpdir(), "patchdesk-walkthrough-oversized-"));
    const contextPath = join(directory, "context.json");
    const patchPath = join(directory, "patch.diff");
    await writeFile(contextPath, "context artifact");
    await writeFile(patchPath, Buffer.alloc(2 * 1024 * 1024 + 1, 0x78));
    try {
      await expect(prepareWalkthroughPrompt({
        profileId: "profile-1",
        sessionId: "session-1",
        contextPath,
        patchPath,
        model: "model-explicit",
        reasoning: "high",
      })).rejects.toThrow("Walkthrough artifact exceeds the bounded input size");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
