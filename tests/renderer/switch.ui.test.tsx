// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Switch } from "../../src/renderer/src/components/ui/switch";

afterEach(cleanup);

describe("Switch", () => {
  it("exposes the checked state on a switch role", () => {
    render(<Switch checked aria-label="Line numbers" />);

    expect(
      screen
        .getByRole("switch", { checked: true })
        .getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("reports the unchecked state on a switch role", () => {
    render(<Switch checked={false} aria-label="Line numbers" />);

    expect(
      screen
        .getByRole("switch", { checked: false })
        .getAttribute("aria-checked"),
    ).toBe("false");
  });

  it("reports the flipped value when clicked", async () => {
    const onCheckedChange = vi.fn();
    render(
      <Switch
        checked={false}
        onCheckedChange={onCheckedChange}
        aria-label="Line numbers"
      />,
    );

    await userEvent.click(screen.getByRole("switch"));

    expect(onCheckedChange.mock.calls.map(([checked]) => checked)).toEqual([
      true,
    ]);
  });

  it("reports the flipped value when Space is pressed", async () => {
    const onCheckedChange = vi.fn();
    render(
      <Switch
        checked
        onCheckedChange={onCheckedChange}
        aria-label="Line numbers"
      />,
    );

    const control = screen.getByRole("switch");
    control.focus();
    await userEvent.keyboard(" ");

    expect(onCheckedChange.mock.calls.map(([checked]) => checked)).toEqual([
      false,
    ]);
  });

  it("ignores a click and a Space press while disabled", async () => {
    const onCheckedChange = vi.fn();
    render(
      <Switch
        checked={false}
        disabled
        onCheckedChange={onCheckedChange}
        aria-label="Line numbers"
      />,
    );

    const control = screen.getByRole("switch");
    await userEvent.click(control);
    control.focus();
    await userEvent.keyboard(" ");

    expect(onCheckedChange).not.toHaveBeenCalled();
  });
});
