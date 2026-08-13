// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MarkdownLightbox } from "../../src/renderer/src/components/markdown-lightbox";

afterEach(cleanup);

describe("MarkdownLightbox", () => {
  it("makes zoomed content scrollable and pans it by dragging", async () => {
    const user = userEvent.setup();
    render(
      <MarkdownLightbox open onClose={vi.fn()}>
        <div className="size-24" />
      </MarkdownLightbox>,
    );

    const viewport = screen.getByRole("region", { name: "Zoomable content" });
    await user.click(screen.getByRole("button", { name: "Zoom in" }));

    expect(viewport.className).toContain("overflow-auto");
    expect(viewport.className).toContain("cursor-grab");
    expect((viewport.firstElementChild as HTMLElement).style.zoom).toBe("1.25");

    viewport.scrollLeft = 120;
    viewport.scrollTop = 200;
    fireEvent.pointerDown(viewport, {
      pointerId: 1,
      clientX: 300,
      clientY: 400,
    });
    fireEvent.pointerMove(viewport, {
      pointerId: 1,
      clientX: 250,
      clientY: 360,
    });

    expect(viewport.scrollLeft).toBe(170);
    expect(viewport.scrollTop).toBe(240);
  });
});
