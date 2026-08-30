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
  pending: false,
  onProviderChange: vi.fn(),
  onActivateCodex: vi.fn(),
  onRefreshCodexModels: vi.fn(),
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

    // SAFETY: Base UI's Combobox renders the role="combobox" node as a native
    // <input> element (see ModelCombobox), so this query result is always an
    // HTMLInputElement.
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

  it("uses Base Select controls for provider and reasoning choices", async () => {
    const onProviderChange = vi.fn();
    const onReasoningChange = vi.fn();
    const user = userEvent.setup();
    render(
      <InsightRunDialog
        {...baseProps}
        onProviderChange={onProviderChange}
        onReasoningChange={onReasoningChange}
        model="provider/model-0"
      />,
    );

    const provider = screen.getByRole("combobox", {
      name: "Insight provider",
    });
    const reasoning = screen.getByRole("combobox", {
      name: "Insight reasoning",
    });
    expect(provider).not.toBeInstanceOf(HTMLSelectElement);
    expect(provider.getAttribute("data-slot")).toBe("select-trigger");
    expect(reasoning).not.toBeInstanceOf(HTMLSelectElement);
    expect(reasoning.getAttribute("data-slot")).toBe("select-trigger");

    await user.click(provider);
    await user.click(
      await screen.findByRole("option", { name: "Codex CLI account" }),
    );
    expect(onProviderChange).toHaveBeenCalledWith("codex-cli-account");

    await user.click(reasoning);
    await user.click(await screen.findByRole("option", { name: "high" }));
    expect(onReasoningChange).toHaveBeenCalledWith("high");
  });
});

describe("InsightRunDialog pending state", () => {
  it("shows a disabled shadcn start spinner and blocks dismissal", async () => {
    const onOpenChange = vi.fn();
    const user = userEvent.setup();
    render(
      <InsightRunDialog
        {...baseProps}
        model="provider/model-0"
        pending
        onOpenChange={onOpenChange}
      />,
    );

    const start = screen.getByRole("button", { name: "Starting…" });
    expect(start.getAttribute("disabled")).not.toBeNull();
    expect(start.querySelector('[data-icon="inline-start"]')).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Cancel" }).getAttribute("disabled"),
    ).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
    await user.keyboard("{Escape}");
    expect(onOpenChange).not.toHaveBeenCalled();
  });
});

describe("InsightRunDialog Codex model loading", () => {
  it("offers Refresh models instead of Load Codex models once models are cached", () => {
    render(
      <InsightRunDialog
        {...baseProps}
        provider="codex-cli-account"
        models={[{ id: "codex/gpt", label: "Codex GPT" }]}
        model="codex/gpt"
      />,
    );

    expect(screen.getByRole("button", { name: "Refresh models" })).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Load Codex models" }),
    ).toBeNull();
  });

  it("still asks for the explicit first fetch when no Codex models are available", () => {
    render(
      <InsightRunDialog
        {...baseProps}
        provider="codex-cli-account"
        models={[]}
      />,
    );

    expect(
      screen.getByRole("button", { name: "Load Codex models" }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Refresh models" })).toBeNull();
    expect(
      screen.getByText(
        "Codex models are loaded only after this explicit action.",
      ),
    ).toBeTruthy();
  });
});
