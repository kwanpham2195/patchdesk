// @vitest-environment jsdom

import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
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
  briefInsight,
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

/** Applies the slot's workbench patches, as the Review workbench does. */
function PatchedInsights({
  initial,
}: {
  readonly initial: WorkbenchResponse;
}): React.JSX.Element {
  const [workbench, setWorkbench] = useState(initial);
  return (
    <InsightsSlot
      workbench={workbench}
      onWorkbenchReplace={setWorkbench}
      onWorkbenchPatch={({ insights, ...rest }) =>
        setWorkbench((current) => ({
          ...current,
          ...rest,
          insights: { ...current.insights, ...insights },
        }))
      }
      onReprepare={async () => workbench}
    />
  );
}

function renderInsights(workbench: WorkbenchResponse): void {
  render(<PatchedInsights initial={workbench} />);
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

  it("shows Running on each started Insight's tab until its run ends, then the result's status (#670)", async () => {
    const workbench = withAnalysis("actionable");
    let finishBrief: (response: DesktopResponse) => void = () => undefined;
    const briefPoll = new Promise<DesktopResponse>((resolve) => {
      finishBrief = resolve;
    });
    desktop = installDesktopDouble({
      // SAFETY: the provider catalog and workbench fixtures are JSON-compatible data.
      "/v1/insight-providers": () =>
        success(structuredClone(catalog) as RawJsonValue),
      "/v1/reviews/insights/brief/run": () => accepted("brief"),
      "/v1/reviews/insights/walkthrough/run": () => accepted("walkthrough"),
      "/v1/reviews/insights/runs/run-brief": () => briefPoll,
      "/v1/reviews/insights/runs/run-walkthrough": () => new Promise(() => {}),
      "/v1/reviews/load": () =>
        success(
          structuredClone({
            ...workbench,
            insights: { ...workbench.insights, brief: briefInsight() },
          }) as RawJsonValue,
        ),
    });
    const user = userEvent.setup();
    renderInsights(workbench);
    const rail = within(
      screen.getByRole("navigation", { name: "Insight navigation" }),
    );
    expect(rail.getByRole("tab", { name: "Brief: Not run" })).toBeTruthy();

    const dialog = await openRunInsights(user);
    await user.click(
      within(dialog).getByRole("button", { name: "Start runs" }),
    );

    expect(
      await rail.findByRole("tab", { name: "Brief: Running" }),
    ).toBeTruthy();
    expect(
      rail.getByRole("tab", { name: "Walkthrough: Running" }),
    ).toBeTruthy();

    finishBrief(
      success({ runId: "run-brief", type: "brief", status: "completed" }),
    );

    expect(await rail.findByRole("tab", { name: "Brief" })).toBeTruthy();
    expect(
      rail.getByRole("tab", { name: "Walkthrough: Running" }),
    ).toBeTruthy();
  });
});
