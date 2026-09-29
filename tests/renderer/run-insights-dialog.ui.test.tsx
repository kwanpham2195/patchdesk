// @vitest-environment jsdom

import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";

import type { RawJsonValue } from "../../src/domain/json";
import type { DesktopResponse } from "../../src/main/ipc-contract";
import type { WorkbenchResponse } from "../../src/renderer/src/renderer-contracts";
import { InsightsSlot } from "../../src/renderer/src/components/review-insights-slot";
import { saveInsightRunPreference } from "../../src/renderer/src/insight-run-preferences";
import {
  failure,
  installDesktopDouble,
  success,
  type DesktopDouble,
} from "./fake-desktop-response";
import {
  projection,
  providerCatalog,
  withAnalysis,
} from "./review-workbench-fixtures";

const catalog = {
  ...providerCatalog,
  models: [
    ...providerCatalog.models,
    {
      provider: "pi",
      id: "second-model",
      label: "Second model",
      reasoning: ["low", "high"],
      defaultReasoning: "low",
    },
  ],
};

let desktop: DesktopDouble | undefined;

afterEach(() => {
  cleanup();
  desktop?.restore();
  desktop = undefined;
  window.localStorage.clear();
});

/** Routes the catalog and records every start body by Insight type; `answer` decides each start's reply. */
function installRuns(answer: (type: string) => DesktopResponse) {
  const bodies = {
    brief: new Array<unknown>(),
    walkthrough: new Array<unknown>(),
    analysis: new Array<unknown>(),
  };
  const routes = Object.fromEntries(
    (["brief", "walkthrough", "analysis"] as const).flatMap((type) => [
      [
        `/v1/reviews/insights/${type}/run`,
        (input: { readonly body?: unknown }) => {
          bodies[type].push(input.body);
          return answer(type);
        },
      ],
      // The poll never settles, so an accepted run stays queued.
      [`/v1/reviews/insights/runs/run-${type}`, () => new Promise(() => {})],
    ]),
  );
  desktop = installDesktopDouble({
    // SAFETY: the provider catalog fixture is JSON-compatible data.
    "/v1/insight-providers": () =>
      success(structuredClone(catalog) as RawJsonValue),
    ...routes,
  });
  return bodies;
}

function accepted(type: string) {
  return success({ runId: `run-${type}`, type, status: "queued" });
}

function renderInsights(workbench: WorkbenchResponse): void {
  render(
    <InsightsSlot
      workbench={workbench}
      onWorkbenchReplace={() => undefined}
      onWorkbenchPatch={() => undefined}
      onReprepare={async () => workbench}
    />,
  );
}

async function openRunInsights(user: ReturnType<typeof userEvent.setup>) {
  const open = screen.getByRole("button", { name: "Run Insights…" });
  await waitFor(() => expect(open.hasAttribute("disabled")).toBe(false));
  await user.click(open);
  return screen.getByRole("dialog");
}

function row(dialog: HTMLElement, noun: string) {
  return within(within(dialog).getByRole("group", { name: noun }));
}

function isChecked(checkbox: HTMLElement): boolean {
  return checkbox.getAttribute("aria-checked") === "true";
}

describe("Run Insights dialog", () => {
  it("seeds each row from its saved options, checks only Insights without a current result, and starts each checked one once", async () => {
    const bodies = installRuns(accepted);
    saveInsightRunPreference("profile", "brief", {
      provider: "pi",
      model: "second-model",
      reasoning: "high",
      language: "vi",
    });
    saveInsightRunPreference("profile", "walkthrough", {
      provider: "pi",
      model: "fixture-model",
      reasoning: "medium",
      language: "en",
    });
    const user = userEvent.setup();
    renderInsights(withAnalysis("actionable"));

    const dialog = await openRunInsights(user);
    const brief = row(dialog, "Brief");
    // SAFETY: ModelCombobox renders its role="combobox" node as a native <input>.
    const briefModel = brief.getByRole("combobox", {
      name: "Brief model",
    }) as HTMLInputElement;
    expect(briefModel.value).toBe("Second model");
    expect(
      brief.getByRole("combobox", { name: "Brief reasoning" }).textContent,
    ).toContain("high");
    expect(
      brief.getByRole("combobox", { name: "Brief language" }).textContent,
    ).toContain("Vietnamese");
    expect(isChecked(brief.getByRole("checkbox"))).toBe(true);
    expect(isChecked(row(dialog, "Walkthrough").getByRole("checkbox"))).toBe(
      true,
    );
    // The Analysis is current for this revision, so it is not paid for again by default.
    expect(isChecked(row(dialog, "Analysis").getByRole("checkbox"))).toBe(
      false,
    );

    await user.click(
      within(dialog).getByRole("button", { name: "Start runs" }),
    );

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(bodies.brief).toEqual([
      expect.objectContaining({
        type: "brief",
        model: "second-model",
        reasoning: "high",
        language: "vi",
      }),
    ]);
    expect(bodies.walkthrough).toEqual([
      expect.objectContaining({ type: "walkthrough", model: "fixture-model" }),
    ]);
    expect(bodies.analysis).toEqual([]);
  });

  it("disables a running Insight and keeps a refused start on its own row while the others start", async () => {
    const bodies = installRuns((type) =>
      type === "brief"
        ? failure({ message: "runtime unavailable" })
        : accepted(type),
    );
    const user = userEvent.setup();
    renderInsights(
      projection({
        insights: {
          analysis: { status: "outdated" },
          walkthrough: {
            status: "running",
            activeRun: {
              runId: "run-walkthrough",
              sessionId: "session-a",
              startedAt: "2026-08-01T00:00:00.000Z",
            },
          },
        },
      }),
    );

    const dialog = await openRunInsights(user);
    const walkthroughCheckbox = row(dialog, "Walkthrough").getByRole(
      "checkbox",
    );
    expect(isChecked(walkthroughCheckbox)).toBe(false);
    expect(walkthroughCheckbox.getAttribute("aria-disabled")).toBe("true");

    await user.click(
      within(dialog).getByRole("button", { name: "Start runs" }),
    );

    expect(await row(dialog, "Brief").findByRole("alert")).toBeTruthy();
    expect(screen.getByRole("dialog")).toBe(dialog);
    expect(row(dialog, "Analysis").queryByRole("alert")).toBeNull();
    expect(bodies.brief).toHaveLength(1);
    expect(bodies.analysis).toEqual([
      expect.objectContaining({ type: "analysis" }),
    ]);
    expect(bodies.walkthrough).toEqual([]);
  });
});
