import { describe, expect, it } from "vitest";

import {
  indexPatchHunks,
  type LocalPatchView,
} from "../../src/domain/local-patch-view";
import type { LocalDraftEntry } from "../../src/renderer/src/local-draft-contracts";
import {
  placeLocalDraft,
  type LocalDraftPlacement,
  type LocalDraftPlacementContext,
} from "../../src/renderer/src/local-draft-placement";

/** src/a.ts's first three lines changed, on both sides. */
const patchOfA = [
  "diff --git a/src/a.ts b/src/a.ts",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,3 +1,3 @@",
  "-one",
  "-two",
  "-three",
  "+ONE",
  "+TWO",
  "+THREE",
  "",
].join("\n");

/** src/a.ts differs between every pair of trees, so a note on it is inline only on its own tree. */
function shown(view: LocalPatchView): LocalDraftPlacementContext {
  return {
    sessionId: "session-a",
    view,
    notes: {
      view,
      paths: {
        combined: ["src/a.ts"],
        committed: ["src/a.ts"],
        uncommitted: ["src/a.ts"],
      },
      shownHunks: indexPatchHunks(patchOfA),
    },
    analysisRunId: "run-2",
    findings: [
      {
        id: "finding-1",
        file: "src/a.ts",
        lineStart: 2,
        lineEnd: 3,
        diffSide: "new",
      },
    ],
  };
}

type NoteEntry = Extract<LocalDraftEntry, { readonly kind: "note" }>;

function note(overrides: Partial<Omit<NoteEntry, "kind">> = {}): NoteEntry {
  return {
    kind: "note",
    noteId: "note-1",
    sessionId: "session-a",
    view: "combined",
    path: "src/a.ts",
    side: "new",
    startLine: 1,
    line: 2,
    text: "Guard the empty case.",
    ...overrides,
  };
}

function finding(analysisRunId: string): LocalDraftEntry {
  return {
    kind: "finding",
    findingId: "finding-1",
    analysisRunId,
    sessionId: "session-a",
    view: "combined",
    path: "src/a.ts",
    side: "new",
    startLine: 1,
    line: 1,
    title: "Missing guard",
    suggests: false,
  };
}

function inline(
  side: "new" | "old",
  startLine: number,
  line: number,
): LocalDraftPlacement {
  return { placement: "inline", path: "src/a.ts", side, startLine, line };
}

describe("placeLocalDraft", () => {
  it.each<{
    readonly name: string;
    readonly entry: LocalDraftEntry;
    readonly context: LocalDraftPlacementContext;
    readonly expected: LocalDraftPlacement;
  }>([
    {
      name: "an Uncommitted note shows in Combined, whose new side is the same snapshot",
      entry: note({ view: "uncommitted" }),
      context: shown("combined"),
      expected: inline("new", 1, 2),
    },
    {
      name: "a Combined old-side note shows in Committed, whose old side is the same merge base",
      entry: note({ side: "old", startLine: 3, line: 3 }),
      context: shown("committed"),
      expected: inline("old", 3, 3),
    },
    {
      name: "an Uncommitted note shows in Uncommitted",
      entry: note({ view: "uncommitted" }),
      context: shown("uncommitted"),
      expected: inline("new", 1, 2),
    },
    {
      name: "a note on a Review without views shows at its stored lines",
      entry: note({ startLine: 40, line: 41 }),
      context: {
        ...shown("combined"),
        view: undefined,
        notes: undefined,
      },
      expected: inline("new", 40, 41),
    },
    {
      name: "a drafted Finding of the current Analysis shows where the Analysis maps it",
      entry: finding("run-2"),
      context: shown("combined"),
      expected: inline("new", 2, 3),
    },
    {
      name: "earlier_session: a note that stayed on an earlier session",
      entry: note({ sessionId: "session-old" }),
      context: shown("combined"),
      expected: { placement: "not_inline", reason: "earlier_session" },
    },
    {
      name: "tree_not_in_view: an Uncommitted note in Committed, whose new side is HEAD",
      entry: note({ view: "uncommitted" }),
      context: shown("committed"),
      expected: { placement: "not_inline", reason: "tree_not_in_view" },
    },
    {
      name: "outside_hunk: a note on lines the shown patch does not show",
      entry: note({ startLine: 40, line: 41 }),
      context: shown("combined"),
      expected: { placement: "not_inline", reason: "outside_hunk" },
    },
    {
      name: "finding_off_combined: a current drafted Finding while Committed shows",
      entry: finding("run-2"),
      context: shown("committed"),
      expected: { placement: "not_inline", reason: "finding_off_combined" },
    },
    {
      name: "finding_not_current: a drafted Finding of an earlier Analysis run",
      entry: finding("run-1"),
      context: shown("combined"),
      expected: { placement: "not_inline", reason: "finding_not_current" },
    },
  ])("$name", ({ entry, context, expected }) => {
    expect(placeLocalDraft(entry, context)).toEqual(expected);
  });
});
