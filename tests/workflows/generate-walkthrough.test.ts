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
  walkthroughOutputLimitDiagnostic,
} from "../../src/services/walkthrough-operation";

const validOutput = {
  citationVersion: 2,
  title: "Recovery walkthrough",
  focus: "Follow the recovery decision.",
  chapters: [
    {
      title: "Recovery",
      sections: [
        {
          title: "One action",
          prose: "The projection selects one action.",
          hunkIds: ["h1"],
        },
      ],
    },
  ],
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
      await expect(readBoundedArtifact(path, 10)).resolves.toEqual({
        _tag: "ok",
        value: "0123456789",
      });
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
  it("rejects aggregate overflow at the output schema boundary", () => {
    const chapters = Array.from({ length: 2 }, (_, chapterIndex) => ({
      title: `Chapter ${chapterIndex}`,
      sections: Array.from({ length: 17 }, (_, sectionIndex) => ({
        title: `Section ${chapterIndex}-${sectionIndex}`,
        prose: "A bounded explanation.",
        hunkIds: ["h1"],
      })),
    }));
    expect(
      v.safeParse(walkthroughOutputSchema, { ...validOutput, chapters })
        .success,
    ).toBe(false);
  });

  it("reports only bounded field counts for oversized generated sections", () => {
    const result = {
      ...validOutput,
      chapters: [
        {
          ...baseChapter,
          sections: [
            {
              ...baseSection,
              prose: "private prose ".repeat(27),
              hunkIds: Array.from({ length: 127 }, () => "h1"),
            },
          ],
        },
      ],
    };
    expect(walkthroughOutputLimitDiagnostic(result)).toBe(
      "chapters[0].sections[0].prose_378_gt_320,chapters[0].sections[0].hunkIds_127_gt_32",
    );
    expect(walkthroughOutputLimitDiagnostic(validOutput)).toBeUndefined();
  });

  it.each([
    ["focus", { ...validOutput, focus: "x".repeat(321) }, "focus_321_gt_320"],
    [
      "chapter title",
      {
        ...validOutput,
        chapters: [{ ...baseChapter, title: "x".repeat(81) }],
      },
      "chapters[0].title_81_gt_80",
    ],
    [
      "section title",
      {
        ...validOutput,
        chapters: [
          {
            ...baseChapter,
            sections: [{ ...baseSection, title: "x".repeat(161) }],
          },
        ],
      },
      "chapters[0].sections[0].title_161_gt_160",
    ],
    [
      "hunk alias",
      {
        ...validOutput,
        chapters: [
          {
            ...baseChapter,
            sections: [{ ...baseSection, hunkIds: [`h${"1".repeat(16)}`] }],
          },
        ],
      },
      "chapters[0].sections[0].hunkIds[0]_17_gt_16",
    ],
  ])(
    "reports the rejected %s limit without field text",
    (_field, result, detail) => {
      expect(walkthroughOutputLimitDiagnostic(result)).toBe(detail);
    },
  );

  it("rejects wrong shapes and extra keys", () => {
    expect(
      parseWalkthroughOutput({ ...validOutput, unexpected: true }),
    ).toEqual({
      _tag: "err",
      error: { _tag: "InvalidWalkthroughOutput" },
    });
    expect(parseWalkthroughOutput({ title: "missing" })).toEqual({
      _tag: "err",
      error: { _tag: "InvalidWalkthroughOutput" },
    });
  });

  it("rejects oversized prose, invalid aliases, and aggregate section overflow", () => {
    expect(
      parseWalkthroughOutput({
        ...validOutput,
        chapters: [
          {
            ...baseChapter,
            sections: [{ ...baseSection, prose: "x".repeat(4_001) }],
          },
        ],
      }),
    ).toEqual({ _tag: "err", error: { _tag: "InvalidWalkthroughOutput" } });
    expect(
      parseWalkthroughOutput({
        ...validOutput,
        chapters: [
          {
            ...baseChapter,
            sections: [{ ...baseSection, hunkIds: ["h12345678901234567"] }],
          },
        ],
      }),
    ).toEqual({ _tag: "err", error: { _tag: "InvalidWalkthroughOutput" } });
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
    expect(
      v.safeParse(walkthroughOutputSchema, {
        ...validOutput,
        focus: "x".repeat(320),
        chapters: [
          {
            ...baseChapter,
            sections: [{ ...baseSection, prose: "x".repeat(320) }],
          },
        ],
      }).success,
    ).toBe(true);
    expect(
      v.safeParse(walkthroughOutputSchema, {
        ...validOutput,
        chapters: [
          {
            ...baseChapter,
            sections: [{ ...baseSection, prose: "x".repeat(321) }],
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      v.safeParse(walkthroughOutputSchema, {
        ...validOutput,
        focus: "x".repeat(321),
      }).success,
    ).toBe(false);
  });
});

describe("walkthrough prompt preparation", () => {
  it("uses fixed bounded artifacts, plain-text section rules, and no write instructions", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "patchdesk-walkthrough-prompt-"),
    );
    const contextPath = join(directory, "context.json");
    const patchPath = join(directory, "patch.diff");
    await writeFile(contextPath, "context artifact");
    await writeFile(
      patchPath,
      "diff --git a/src/recovery.ts b/src/recovery.ts\n--- a/src/recovery.ts\n+++ b/src/recovery.ts\n@@ -1,1 +1,1 @@\n-old\n+new\n",
    );
    try {
      const prepared = await prepareWalkthroughPrompt({
        contextPath,
        patchPath,
        language: "en",
      });
      if (prepared._tag === "err")
        throw new Error(
          `walkthrough prompt preparation failed: ${prepared.error.reason}`,
        );
      const prompt = prepared.value;
      expect(prompt).toContain("behavior before consequences and validation");
      expect(prompt).toContain('BCP 47 tag "en"');
      expect(prompt).toContain(
        "Do not translate technical terms into the output language; use the terms established by the supplied repository evidence or common software engineering usage.",
      );
      expect(prompt).toContain(
        "Use short, direct sentences in the active voice",
      );
      expect(prompt).toContain("Do not narrate the patch file by file");
      expect(prompt).toContain(
        "Write every chapter title, section title, and prose string as plain text. Use no Markdown: no bullet or heading markers, no emphasis markers, and no backticks.",
      );
      expect(prompt).toContain(
        "State what the patch does, never why it was made",
      );
      expect(prompt).toContain("HUNK ALIAS MANIFEST");
      expect(prompt).toContain("h1 | src/recovery.ts | @@ -1,1 +1,1 @@");
      expect(prompt).toContain("citationVersion to 2");
      expect(prompt).toContain("representative hunks");
      expect(prompt).toContain("at most 36 distinct hunks");
      expect(prompt).not.toContain("This patch spans");
      expect(prompt).toContain(
        "Hunks you do not cite are not explained in the reading path",
      );
      expect(prompt).not.toContain("Cite every hunk that carries behavior");
      expect(prompt).toContain("context artifact");
      expect(prompt).not.toMatch(
        /review completion|review failure|workflow:review-pr|commenting|persist(?:ence|ed|ing)/i,
      );
      expect(prompt).not.toContain("primary section");
      expect(prompt).not.toContain("linear picker");
      expect(prompt).not.toContain("Markdown form");
      expect(prompt).not.toContain("profile-1");
      expect(prompt).not.toContain("session-1");
      expect(prompt).not.toContain("300 characters");
      expect(prompt).not.toContain("Create at most");
      expect(prompt.split("each section's prose within 320").length - 1).toBe(
        1,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("offers a bounded reading path for a patch with 200 files and 952 hunks", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "patchdesk-walkthrough-large-"),
    );
    const contextPath = join(directory, "context.json");
    const patchPath = join(directory, "patch.diff");
    const patch =
      Array.from({ length: 200 }, (_, fileIndex) => {
        const path = `src/module-${fileIndex + 1}.ts`;
        const hunkCount = fileIndex < 152 ? 5 : 4;
        return [
          `diff --git a/${path} b/${path}`,
          `--- a/${path}`,
          `+++ b/${path}`,
          ...Array.from({ length: hunkCount }, (_, hunkIndex) =>
            [
              `@@ -${hunkIndex},0 +${hunkIndex + 1} @@`,
              `+const value${hunkIndex} = true;`,
            ].join("\n"),
          ),
        ].join("\n");
      }).join("\n") + "\n";
    await writeFile(contextPath, "context artifact");
    await writeFile(patchPath, patch);
    try {
      const prepared = await prepareWalkthroughPrompt({
        contextPath,
        patchPath,
        language: "vi",
      });
      if (prepared._tag === "err")
        throw new Error("Expected a large patch prompt");
      expect(prepared.value).toContain("h952 | src/module-200.ts");
      expect(prepared.value).toContain("at most 36 distinct hunks");
      expect(prepared.value).toContain(
        "This patch spans 200 files and 952 hunks",
      );
      expect(prepared.value).toContain(
        "aim for 3–6 chapters and 8–12 sections",
      );
      expect(prepared.value).toContain(
        "Hunks you do not cite are not explained",
      );
      expect(prepared.value).not.toContain(
        "Cite every hunk that carries behavior",
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects an oversized artifact before composing model input", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "patchdesk-walkthrough-oversized-"),
    );
    const contextPath = join(directory, "context.json");
    const patchPath = join(directory, "patch.diff");
    await writeFile(contextPath, "context artifact");
    await writeFile(patchPath, Buffer.alloc(2 * 1024 * 1024 + 1, 0x78));
    try {
      await expect(
        prepareWalkthroughPrompt({
          contextPath,
          patchPath,
          language: "en",
        }),
      ).resolves.toEqual({
        _tag: "err",
        error: { reason: "artifact_too_large", artifact: "patch" },
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("names the artifact it could not read at all", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "patchdesk-walkthrough-unreadable-"),
    );
    const contextPath = join(directory, "context.json");
    await writeFile(contextPath, "context artifact");
    try {
      await expect(
        prepareWalkthroughPrompt({
          contextPath,
          patchPath: join(directory, "missing.diff"),
          language: "en",
        }),
      ).resolves.toEqual({
        _tag: "err",
        error: { reason: "artifact_unreadable", artifact: "patch" },
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
