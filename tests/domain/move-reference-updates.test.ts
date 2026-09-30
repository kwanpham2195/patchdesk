import { describe, expect, it } from "vitest";

import { countMoveReferenceUpdates } from "../../src/domain/move-reference-updates";

function edited(
  path: string,
  removed: ReadonlyArray<string>,
  added: ReadonlyArray<string>,
): string {
  return [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -1,${removed.length} +1,${added.length} @@`,
    ...removed.map((line) => `-${line}`),
    ...added.map((line) => `+${line}`),
  ].join("\n");
}

function count(...sections: ReadonlyArray<string>): number {
  return countMoveReferenceUpdates(`${sections.join("\n")}\n`);
}

describe("countMoveReferenceUpdates", () => {
  it("counts a Go file whose import moved and whose code follows the renamed qualifier", () => {
    expect(
      count(
        edited(
          "api/handler_test.go",
          [
            '\tsharedmocks "example.com/svc/shared/mocks"',
            '\tv1 "example.com/svc/api/pkg/model/v1"',
            "\trepo := sharedmocks.NewBulkUpdateRepository(t)",
            "\tvar req v1.ConfirmRequest",
          ],
          [
            '\tbulkupdatemocks "example.com/svc/internal/bulkupdate/mocks"',
            '\tbulkupdateapi "example.com/svc/pkg/api/bulkupdate"',
            "\trepo := bulkupdatemocks.NewBulkUpdateRepository(t)",
            "\tvar req bulkupdateapi.ConfirmRequest",
          ],
        ),
      ),
    ).toBe(1);
  });

  it("counts a module file whose only change is an import path", () => {
    expect(
      count(
        edited(
          "src/app.ts",
          ['import { run } from "./old/run";'],
          ['import { run } from "./new/run";'],
        ),
      ),
    ).toBe(1);
  });

  it("does not count a file that also changes behavior next to its import", () => {
    expect(
      count(
        edited(
          "api/service.go",
          ['\t"example.com/svc/shared"', "\tif err != nil { return err }"],
          [
            '\t"example.com/svc/internal/platform"',
            "\tif err != nil { return platform.Wrap(err) }",
          ],
        ),
      ),
    ).toBe(0);
  });

  it("does not count a changed exported string constant as an import", () => {
    expect(
      count(
        edited(
          "src/config.ts",
          ['export const root = "./old";'],
          ['export const root = "./new";'],
        ),
      ),
    ).toBe(0);
  });

  it("does not count an edit with no changed import, or a file the patch adds or renames", () => {
    expect(
      count(
        edited("api/a.go", ["\tshared.Run()"], ["\tplatform.Run()"]),
        [
          "diff --git a/src/new.ts b/src/new.ts",
          "--- /dev/null",
          "+++ b/src/new.ts",
          "@@ -0,0 +1 @@",
          '+import { run } from "./run";',
        ].join("\n"),
        [
          "diff --git a/src/old/b.ts b/src/new/b.ts",
          "similarity index 90%",
          "rename from src/old/b.ts",
          "rename to src/new/b.ts",
          "--- a/src/old/b.ts",
          "+++ b/src/new/b.ts",
          "@@ -1 +1 @@",
          '-import { run } from "../old/run";',
          '+import { run } from "../new/run";',
        ].join("\n"),
      ),
    ).toBe(0);
  });
});
