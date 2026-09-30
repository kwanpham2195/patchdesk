import { describe, expect, it } from "vitest";

import { normalizeBrief, type BriefSnapshot } from "../../src/domain/brief";
import { briefMoves } from "../../src/domain/brief-moves";
import {
  parseContentHash,
  parseGitSha,
  parseReviewSessionId,
  parseWorkspaceProfileId,
} from "../../src/domain/ids";
import { countMoveReferenceUpdates } from "../../src/domain/move-reference-updates";
import { listPatchChangedFiles } from "../../src/domain/patch-changed-files";
import type { Result } from "../../src/domain/result";
import { parseStoredBrief } from "../../src/domain/stored-brief";

/** One rename section; `edited` adds a one-line hunk so the file also changed. */
function rename(from: string, to: string, edited = false): string {
  return [
    `diff --git a/${from} b/${to}`,
    edited ? "similarity index 90%" : "similarity index 100%",
    `rename from ${from}`,
    `rename to ${to}`,
    ...(edited
      ? [`--- a/${from}`, `+++ b/${to}`, "@@ -1 +1 @@", "-old", "+new"]
      : []),
  ].join("\n");
}

function modified(path: string): string {
  return [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    "@@ -1 +1 @@",
    "-old",
    "+new",
  ].join("\n");
}

function movesOf(...sections: ReadonlyArray<string>) {
  const patch = `${sections.join("\n")}\n`;
  return briefMoves(
    listPatchChangedFiles(patch),
    countMoveReferenceUpdates(patch),
  );
}

function value<T>(result: Result<T, unknown>): T {
  if (result._tag === "err") throw new Error("expected ok");
  return result.value;
}

describe("briefMoves", () => {
  it("groups renames by the directories they moved between and leads when moves outnumber other changes", () => {
    const moves = movesOf(
      rename("api/cmd/testdata/a.json", "cmd/api/testdata/a.json"),
      rename("api/cmd/testdata/b.json", "cmd/api/testdata/b.json", true),
      rename("api/cmd/main.go", "cmd/api/main.go"),
      modified("Makefile"),
    );
    expect(moves?.rows).toEqual([
      { from: "api/cmd/", to: "cmd/api/", files: 3, editedFiles: 1, names: 1 },
    ]);
    expect(moves?.movedFiles).toBe(3);
    expect(moves?.leads).toBe(true);
  });

  it("does not lead when modified files outnumber moved ones", () => {
    const moves = movesOf(
      rename("shared/db/pool.go", "internal/platform/db/pool.go"),
      rename("shared/db/tx.go", "internal/platform/db/tx.go"),
      modified("api/a.go"),
      modified("api/b.go"),
      modified("api/c.go"),
    );
    expect(moves?.rows[0]).toMatchObject({
      from: "shared/",
      to: "internal/platform/",
    });
    expect(moves?.leads).toBe(false);
  });

  it("leads when files that only follow the move make moves the larger share", () => {
    const importUpdate = (path: string) =>
      [
        `diff --git a/${path} b/${path}`,
        `--- a/${path}`,
        `+++ b/${path}`,
        "@@ -1 +1 @@",
        '-import { pool } from "../shared/db/pool";',
        '+import { pool } from "../internal/platform/db/pool";',
      ].join("\n");
    const moves = movesOf(
      rename("shared/db/pool.ts", "internal/platform/db/pool.ts"),
      rename("shared/db/tx.ts", "internal/platform/db/tx.ts"),
      importUpdate("api/a.ts"),
      importUpdate("api/b.ts"),
      importUpdate("api/c.ts"),
      modified("Makefile"),
    );
    expect(moves?.referenceUpdates).toBe(3);
    expect(moves?.leads).toBe(true);
  });

  it("is absent when renames stay in their directory or only one file moved", () => {
    expect(
      movesOf(
        rename("src/old-name.ts", "src/new-name.ts"),
        rename("src/other.ts", "src/renamed.ts"),
        rename("src/one.ts", "lib/one.ts"),
      ),
    ).toBeUndefined();
  });

  it("keeps a directory that moved under a new parent instead of reading it as the root", () => {
    const moves = movesOf(
      rename("api/configs/dev.json", "deploy/api/configs/dev.json"),
      rename("api/configs/prod.json", "deploy/api/configs/prod.json"),
    );
    expect(moves?.rows).toEqual([
      { from: "api/", to: "deploy/api/", files: 2, editedFiles: 0, names: 1 },
    ]);
  });

  it("merges directory pairs that differ only in one repeated name into one <name> row", () => {
    const moves = movesOf(
      rename("job/vip/cmd/server/main.go", "cmd/vip/main.go"),
      rename("job/sponsor/cmd/server/main.go", "cmd/sponsor/main.go"),
      rename("job/sponsor/cmd/server/run.go", "cmd/sponsor/run.go", true),
    );
    expect(moves?.rows).toEqual([
      {
        from: "job/<name>/cmd/server/",
        to: "cmd/<name>/",
        files: 3,
        editedFiles: 1,
        names: 2,
      },
    ]);
  });

  it("shows the largest moves and counts the rows it leaves out", () => {
    const sections = ["a", "b", "c", "d", "e", "f", "g", "h"].flatMap(
      (name, index) =>
        Array.from({ length: index + 2 }, (_, file) =>
          rename(`old${name}/f${file}.ts`, `new/${name}x/f${file}.ts`),
        ),
    );
    const moves = movesOf(...sections);
    expect(moves?.rows).toHaveLength(6);
    expect(moves?.rows[0]).toMatchObject({ from: "oldh/", files: 9 });
    expect(moves?.hiddenRows).toBe(2);
  });
});

describe("the Moves block on a retained Brief", () => {
  it("is computed from the patch and read back from storage unchanged", () => {
    const patch = `${[
      rename("job/a.json", "deploy/a.json"),
      rename("job/b.json", "deploy/b.json"),
    ].join("\n")}\n`;
    const snapshot: BriefSnapshot = {
      profileId: value(parseWorkspaceProfileId("design")),
      sessionId: value(
        parseReviewSessionId(
          "github.com__octo-org__patchdesk__pr-42__sha-abcdef12__base-12345678__0123456789ab",
        ),
      ),
      headSha: value(parseGitSha("abcdef1234567890abcdef1234567890abcdef12")),
      patchHash: value(parseContentHash("a".repeat(64))),
    };
    const normalized = value(normalizeBrief({}, [], patch, snapshot));
    expect(normalized.moves?.rows).toEqual([
      { from: "job/", to: "deploy/", files: 2, editedFiles: 0, names: 1 },
    ]);
    const stored: unknown = JSON.parse(JSON.stringify(normalized));
    expect(parseStoredBrief(stored)).toEqual({
      _tag: "ok",
      value: normalized,
    });
  });
});
