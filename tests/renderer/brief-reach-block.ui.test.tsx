// @vitest-environment jsdom

import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";

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

    await user.click(screen.getByRole("button", { name: /^3 new names/ }));

    const list = screen.getByRole("list", { name: /^3 new names/ });
    expect(
      within(list)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual(fresh);
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
    expect(within(changed).getByText("7 source · 2 tests")).toBeTruthy();
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
    // An unmentioned legacy name is folded without being called new.
    expect(
      screen.getByRole("button", { name: /^1 name not used outside/ }),
    ).toBeTruthy();
  });
});
