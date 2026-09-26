import { processFile, type FileDiffMetadata } from "@pierre/diffs";
import { describe, expect, it } from "vitest";

import {
  renderedContextOf,
  reviewContextControl,
} from "../../src/renderer/src/review-context-control";

function hydrated(
  patch: string,
  files: Parameters<typeof processFile>[1] = {},
): FileDiffMetadata {
  const file = processFile(patch, files);
  if (file === undefined) throw new Error("fixture patch did not parse");
  return file;
}

const addedFile = hydrated(
  [
    "diff --git a/src/new.ts b/src/new.ts",
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/src/new.ts",
    "@@ -0,0 +1 @@",
    "+export const added = true;",
    "",
  ].join("\n"),
  { newFile: { name: "src/new.ts", contents: "export const added = true;\n" } },
);
const modifiedFile = hydrated(
  [
    "diff --git a/src/a.ts b/src/a.ts",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -3 +3 @@",
    "-const b = 2;",
    "+const b = 3;",
    "",
  ].join("\n"),
  {
    oldFile: {
      name: "src/a.ts",
      contents: "const x = 0;\nconst a = 1;\nconst b = 2;\n",
    },
    newFile: {
      name: "src/a.ts",
      contents: "const x = 0;\nconst a = 1;\nconst b = 3;\n",
    },
  },
);

describe("renderedContextOf", () => {
  it.each([
    {
      name: "only added or deleted files",
      files: [addedFile, addedFile],
      expected: "nothing_to_expand",
    },
    {
      name: "one file not hydrated",
      files: [addedFile, undefined],
      expected: "unknown",
    },
    {
      name: "one file with both sides",
      files: [addedFile, modifiedFile],
      expected: "expandable",
    },
    { name: "no rendered files", files: [], expected: "unknown" },
  ] as const)("classifies $name as $expected", ({ files, expected }) => {
    expect(renderedContextOf(files)).toBe(expected);
  });
});

describe("reviewContextControl", () => {
  it("only enables unchanged-context controls when a rendered diff can expand", () => {
    expect(
      reviewContextControl({
        hasSourceSession: true,
        status: "ready",
        renderedContext: "expandable",
        expanded: false,
      }),
    ).toEqual({
      disabled: false,
      label: "Context",
      description: "Expand unchanged context",
    });
  });

  it("explains why context is disabled while source contents load", () => {
    expect(
      reviewContextControl({
        hasSourceSession: true,
        status: "loading",
        renderedContext: "unknown",
        expanded: false,
      }),
    ).toMatchObject({ disabled: true, label: "Loading context" });
  });

  it("explains when no source session is available instead of exposing a no-op", () => {
    expect(
      reviewContextControl({
        hasSourceSession: false,
        status: "idle",
        renderedContext: "unknown",
        expanded: false,
      }),
    ).toEqual({
      disabled: true,
      label: "Context unavailable",
      description: "Exact file contents are unavailable for this review",
    });
  });

  it("explains when required contents cannot be read from saved revisions", () => {
    expect(
      reviewContextControl({
        hasSourceSession: true,
        status: "unavailable",
        renderedContext: "unknown",
        expanded: false,
        unavailableReason: "github_read",
      }),
    ).toEqual({
      disabled: true,
      label: "Context unavailable",
      description:
        "Patchdesk could not load unchanged context from the saved review revisions",
    });
  });

  it("keeps Context disabled without calling it unavailable when every shown file is added or deleted", () => {
    expect(
      reviewContextControl({
        hasSourceSession: true,
        status: "ready",
        renderedContext: "nothing_to_expand",
        expanded: false,
      }),
    ).toMatchObject({ disabled: true, label: "Context" });
  });

  it("keeps the no-session wording even when nothing is left to expand", () => {
    expect(
      reviewContextControl({
        hasSourceSession: false,
        status: "idle",
        renderedContext: "nothing_to_expand",
        expanded: false,
      }),
    ).toEqual({
      disabled: true,
      label: "Context unavailable",
      description: "Exact file contents are unavailable for this review",
    });
  });
});
