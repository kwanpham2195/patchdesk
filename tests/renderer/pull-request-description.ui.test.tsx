// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { parsePullRequestInput } from "../../src/domain/pull-request";
import {
  PullRequestDescription,
  PullRequestDescriptionPreview,
} from "../../src/renderer/src/components/pull-request-description";

const pullRequest = (() => {
  const parsed = parsePullRequestInput(
    "https://github.com/centraldigital/patchdesk/pull/42",
  );
  if (parsed._tag === "err") throw new Error("Fixture pull request is invalid");
  return parsed.value;
})();

afterEach(() => {
  cleanup();
  delete (window as unknown as { patchdesk?: unknown }).patchdesk;
});

describe("PullRequestDescription", () => {
  it("renders safe GitHub-flavored Markdown and opens only an explicit same-host link", async () => {
    const user = userEvent.setup();
    const openExternalHttps = vi.fn(async () => true);
    Object.defineProperty(window, "patchdesk", {
      configurable: true,
      value: { openExternalHttps },
    });

    render(
      <PullRequestDescription
        markdown={
          "# Context\n\n**Keep this**. [Docs](/centraldigital/patchdesk/wiki)\n\n<script>window.bad = true</script>\n\n[javascript](javascript:alert(1))\n\n[Other](https://example.com/docs)"
        }
        pullRequest={pullRequest}
      />,
    );

    expect(screen.getByRole("heading", { name: "Context" })).toBeTruthy();
    expect(screen.getByText("Keep this")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Docs" })).toBeTruthy();
    expect(screen.queryByRole("link")).toBeNull();
    expect(document.querySelector("script")).toBeNull();
    expect(screen.queryByRole("link", { name: "javascript" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Other" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "Docs" }));
    expect(openExternalHttps).toHaveBeenCalledWith(
      "https://github.com/centraldigital/patchdesk/wiki",
    );
  });

  it("states when the author did not provide a description", () => {
    render(<PullRequestDescription />);
    expect(
      screen.getByText("No description was provided on GitHub."),
    ).toBeTruthy();
  });

  it("preserves safe GitHub HTML and image content without executing arbitrary markup", () => {
    render(
      <PullRequestDescriptionPreview
        markdown={
          "<details open><summary>Context</summary><p>Details</p></details>\n\n![Architecture diagram](/centraldigital/patchdesk/raw/main/diagram.png)\n\n<script>window.bad = true</script>"
        }
        pullRequest={pullRequest}
      />,
    );

    expect(screen.getByText("Context")).toBeTruthy();
    expect(screen.getByText("Details")).toBeTruthy();
    expect(
      screen.getByRole("img", { name: "Architecture diagram" }),
    ).toBeTruthy();
    expect(document.querySelector("script")).toBeNull();
    expect((window as unknown as { bad?: boolean }).bad).toBeUndefined();
  });

  it("renders Mermaid fences as a diagram surface with readable source fallback", async () => {
    render(
      <PullRequestDescriptionPreview
        markdown={"```mermaid\ngraph TD\n  A[Start] --> B[Review]\n```"}
        pullRequest={pullRequest}
      />,
    );

    expect(screen.getByLabelText("Mermaid diagram")).toBeTruthy();
    expect(screen.getByText(/graph TD/)).toBeTruthy();
  });

  it("caps a long description at twelve visual lines until Show more is requested", async () => {
    const user = userEvent.setup();
    const originalScrollHeight = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      "scrollHeight",
    );
    const originalResizeObserver = globalThis.ResizeObserver;

    Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
      configurable: true,
      get: () => 320,
    });
    class TestResizeObserver {
      constructor(private readonly callback: ResizeObserverCallback) {}
      observe(): void {
        this.callback([], this as unknown as ResizeObserver);
      }
      disconnect(): void {}
      unobserve(): void {}
    }
    Object.defineProperty(globalThis, "ResizeObserver", {
      configurable: true,
      value: TestResizeObserver,
    });

    try {
      render(<PullRequestDescription markdown="A saved description" />);
      const showMore = await screen.findByRole("button", { name: "Show more" });
      await user.click(showMore);
      expect(screen.getByRole("button", { name: "Show less" })).toBeTruthy();
      expect(
        screen
          .getByText("A saved description")
          .closest('[data-slot="scroll-area"]')?.className,
      ).not.toMatch(/max-h/);
    } finally {
      if (originalScrollHeight === undefined) {
        delete (HTMLElement.prototype as { scrollHeight?: number })
          .scrollHeight;
      } else {
        Object.defineProperty(
          HTMLElement.prototype,
          "scrollHeight",
          originalScrollHeight,
        );
      }
      Object.defineProperty(globalThis, "ResizeObserver", {
        configurable: true,
        value: originalResizeObserver,
      });
    }
  });
});
