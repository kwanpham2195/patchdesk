// @vitest-environment jsdom

import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";

import { definedProps } from "../../src/domain/defined-props";
import type { BriefReach } from "../../src/renderer/src/brief-contracts";
import { ReachBlock } from "../../src/renderer/src/components/brief-reach-block";

const HEAD_SHA = "e1126f94".padEnd(40, "0");

const reach = (overrides: Partial<BriefReach>): BriefReach => ({
  symbols: [],
  surfaces: [{ surface: "Public API" }],
  untested: [],
  removedStillReferenced: [],
  method: "text_match",
  hop: 1,
  ...overrides,
});

const SOURCE_PATHS = [
  "src/services/assignee-service.ts",
  "src/services/avatar-sync-service.ts",
  "src/services/review-workbench-controller.ts",
  "src/services/label-service.ts",
  "src/services/milestone-service.ts",
  "src/main/local-api.ts",
  "src/main/app-services.ts",
];
const TEST_PATHS = [
  "tests/services/review-lock-invariant-rows.ts",
  "tests/services/review-lock-invariant-services.ts",
];

afterEach(() => cleanup());

describe("ReachBlock", () => {
  it("lists removed names before changed ones", () => {
    render(
      <ReachBlock
        headSha={HEAD_SHA}
        reach={reach({
          symbols: [
            {
              name: "ReviewObservationResult",
              outsideCallerFiles: 1,
              outsidePaths: ["src/renderer/src/flows/use-workbench-actions.ts"],
              insidePR: true,
              status: "changed",
            },
          ],
          removedStillReferenced: [
            { name: "updateComment", paths: ["src/main/local-api.ts"] },
          ],
        })}
      />,
    );

    const removed = screen.getByRole("region", {
      name: "Removed but still mentioned",
    });
    const changed = screen.getByRole("region", {
      name: "Changed and mentioned elsewhere",
    });
    expect(within(removed).getByText("updateComment")).toBeTruthy();
    expect(within(changed).getByText("ReviewObservationResult")).toBeTruthy();
    expect(
      removed.compareDocumentPosition(changed) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("folds names nothing outside mentions until the fold is opened", async () => {
    const user = userEvent.setup();
    const fresh = [
      "RefreshOperationFailure",
      "RefreshOperationStatus",
      "RefreshOperationOutcome",
    ];
    render(
      <ReachBlock
        headSha={HEAD_SHA}
        reach={reach({
          symbols: fresh.map((name) => ({
            name,
            outsideCallerFiles: 0,
            outsidePaths: [],
            insidePR: true,
            status: "new" as const,
          })),
        })}
      />,
    );

    expect(
      screen.queryByRole("region", { name: "Changed and mentioned elsewhere" }),
    ).toBeNull();
    expect(screen.queryByText("RefreshOperationOutcome")).toBeNull();

    await user.click(
      screen.getByRole("button", {
        name: /^3 names nothing outside the changed files mentions \(3 new\)/,
      }),
    );

    const list = screen.getByRole("list", { name: /^3 names nothing outside/ });
    expect(
      within(list)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual(fresh);
  });

  it("splits the folded names into new and changed", () => {
    const quiet = (name: string, status: "new" | "changed") => ({
      name,
      outsideCallerFiles: 0,
      outsidePaths: [],
      insidePR: true,
      status,
    });
    render(
      <ReachBlock
        headSha={HEAD_SHA}
        reach={reach({
          symbols: [
            quiet("RefreshOperationStatus", "new"),
            quiet("RefreshOperationOutcome", "new"),
            quiet("refreshReview", "changed"),
          ],
        })}
      />,
    );

    expect(
      screen.getByRole("button", {
        name: /^3 names nothing outside the changed files mentions \(2 new, 1 changed\)/,
      }),
    ).toBeTruthy();
  });

  it("splits a changed name's files into source and tests and reveals the paths past five on request", async () => {
    const user = userEvent.setup();
    render(
      <ReachBlock
        headSha={HEAD_SHA}
        reach={reach({
          symbols: [
            {
              name: "ReviewRefreshService",
              outsideCallerFiles: 9,
              // Tests first, so grouping has to move them after the source folders.
              outsidePaths: [...TEST_PATHS, ...SOURCE_PATHS],
              insidePR: true,
              status: "changed",
            },
          ],
        })}
      />,
    );

    const changed = screen.getByRole("region", {
      name: "Changed and mentioned elsewhere",
    });
    // Stored without mention sites, the name and summary fall back to files.
    expect(within(changed).getByText("7 source · 2 tests")).toBeTruthy();
    expect(
      screen.getByText(/^9 files could be affected · 7 source, 2 tests/),
    ).toBeTruthy();
    // The first five drawn paths are source files; both test files are past the cut.
    expect(
      within(changed).queryByText("review-lock-invariant-rows.ts"),
    ).toBeNull();
    expect(within(changed).queryByText("app-services.ts")).toBeNull();

    await user.click(within(changed).getByRole("button", { name: "+4 more" }));

    expect(within(changed).getByText("app-services.ts")).toBeTruthy();
    expect(
      within(changed).getByText("review-lock-invariant-rows.ts"),
    ).toBeTruthy();
    expect(
      within(changed).getByText("review-lock-invariant-services.ts"),
    ).toBeTruthy();
  });

  it("shows where each name is mentioned, by function and kind, and leads the summary with calls", () => {
    const at = (
      path: string,
      line: number,
      kind: "call" | "type" | "import" | "other",
      enclosing?: string,
    ) => ({
      path,
      line,
      kind,
      ...definedProps({ enclosing }),
    });
    render(
      <ReachBlock
        headSha={HEAD_SHA}
        reach={reach({
          symbols: [
            {
              name: "ReviewRefreshService",
              outsideCallerFiles: 3,
              outsidePaths: [
                "src/main/local-api.ts",
                "src/services/review-workbench-controller.ts",
                "tests/services/review-refresh.test.ts",
              ],
              insidePR: true,
              status: "changed",
              mentionCount: 5,
              // Stored import before call, so the reader has to order the sites.
              mentions: [
                at("src/main/local-api.ts", 3, "import"),
                at("src/main/local-api.ts", 40, "call", "startLocalApi"),
                at(
                  "src/services/review-workbench-controller.ts",
                  12,
                  "type",
                  "ReviewWorkbenchController",
                ),
                at(
                  "src/services/review-workbench-controller.ts",
                  80,
                  "call",
                  "ReviewWorkbenchController.refresh",
                ),
                at("tests/services/review-refresh.test.ts", 10, "call"),
              ],
            },
          ],
        })}
      />,
    );

    const changed = screen.getByRole("region", {
      name: "Changed and mentioned elsewhere",
    });
    // The test file's call counts once, as a test.
    expect(
      within(changed).getByText("2 calls · 1 type-only · 1 import · 1 test"),
    ).toBeTruthy();
    expect(
      within(
        within(changed).getByRole("list", { name: "Mentions in local-api.ts" }),
      )
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual(["startLocalApicallL40", "top levelimportL3"]);
    expect(
      screen.getByText(
        "2 functions call a changed name · 1 type-only mention · in main, services",
      ),
    ).toBeTruthy();
  });

  it("reads a symbol stored without a status as changed", () => {
    // Briefs retained before `status` existed carry no status field.
    const legacy = [
      {
        name: "ReviewRefreshService",
        outsideCallerFiles: 2,
        outsidePaths: ["src/main/local-api.ts"],
        insidePR: true,
      },
      {
        name: "RefreshOperationStatus",
        outsideCallerFiles: 0,
        outsidePaths: [],
        insidePR: true,
      },
    ];
    render(
      <ReachBlock headSha={HEAD_SHA} reach={reach({ symbols: legacy })} />,
    );

    const changed = screen.getByRole("region", {
      name: "Changed and mentioned elsewhere",
    });
    expect(within(changed).getByText("ReviewRefreshService")).toBeTruthy();
    // The search counted two files but stored one path.
    expect(within(changed).getByText("+1 not listed")).toBeTruthy();
    // An unmentioned legacy name is folded and counted as changed.
    expect(
      screen.getByRole("button", {
        name: /^1 name nothing outside the changed files mentions \(1 changed\)/,
      }),
    ).toBeTruthy();
  });
});
