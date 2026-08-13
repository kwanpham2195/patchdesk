// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { InsightRunDialog } from "../../src/renderer/src/components/insight-run-dialog";

const models = Array.from({ length: 269 }, (_, index) => ({
  id: `provider/model-${index}`,
  label: `Model ${index}`,
}));

const baseProps = {
  open: true,
  type: "walkthrough" as const,
  action: "run" as const,
  provider: "pi" as const,
  codexActivationPending: false,
  codexActivationError: false,
  onProviderChange: vi.fn(),
  onActivateCodex: vi.fn(),
  models,
  model: null,
  reasoning: "medium" as const,
  onOpenChange: vi.fn(),
  onModelChange: vi.fn(),
  onReasoningChange: vi.fn(),
  onConfirm: vi.fn(),
};

afterEach(() => cleanup());

describe("InsightRunDialog model picker", () => {
  it("searches a late model by canonical ID and selects it with the keyboard", async () => {
    const onModelChange = vi.fn();
    const user = userEvent.setup();
    render(<InsightRunDialog {...baseProps} onModelChange={onModelChange} />);

    const input = screen.getByRole("combobox", { name: "Insight model" });
    await user.type(input, "MODEL-268");
    expect(
      await screen.findByRole("option", { name: "Model 268" }),
    ).toBeTruthy();
    await user.keyboard("{ArrowDown}{Enter}");

    expect(onModelChange).toHaveBeenCalledWith("provider/model-268");
  });

  it("disables an empty catalog without exposing provider configuration", () => {
    render(<InsightRunDialog {...baseProps} models={[]} />);

    const input = screen.getByRole("combobox", {
      name: "Insight model",
    }) as HTMLInputElement;
    expect(input.disabled).toBe(true);
    expect(input.placeholder).toBe("No enabled model available");
    expect(screen.queryByText("No models found.")).toBeNull();
  });

  it("reports no results and exposes the reasoning and model labels", async () => {
    const user = userEvent.setup();
    render(<InsightRunDialog {...baseProps} />);

    expect(
      screen.getByRole("combobox", { name: "Insight model" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("combobox", { name: "Insight reasoning" }),
    ).toBeTruthy();
    await user.type(
      screen.getByRole("combobox", { name: "Insight model" }),
      "not-a-model",
    );

    expect(await screen.findByText("No models found.")).toBeTruthy();
  });
});
