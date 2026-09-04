// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { parsePullRequestInput } from "../../src/domain/pull-request";
import {
  PullRequestDescription,
  PullRequestDescriptionPreview,
} from "../../src/renderer/src/components/pull-request-description";
import { installDesktopDouble, success } from "./fake-desktop-response";

const pullRequest = (() => {
  const parsed = parsePullRequestInput(
    "https://github.com/centraldigital/patchdesk/pull/42",
  );
  if (parsed._tag === "err") throw new Error("Fixture pull request is invalid");
  return parsed.value;
})();

const originalShowModalDescriptor = Object.getOwnPropertyDescriptor(
  HTMLDialogElement.prototype,
  "showModal",
);
const originalCloseDescriptor = Object.getOwnPropertyDescriptor(
  HTMLDialogElement.prototype,
  "close",
);

beforeEach(() => {
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
    configurable: true,
    value(this: HTMLDialogElement): void {
      this.setAttribute("open", "");
    },
  });
  Object.defineProperty(HTMLDialogElement.prototype, "close", {
    configurable: true,
    value(this: HTMLDialogElement): void {
      this.removeAttribute("open");
    },
  });
});

let desktop: ReturnType<typeof installDesktopDouble> | undefined;
afterEach(() => {
  cleanup();
  desktop?.restore();
  desktop = undefined;
  restoreDialogMethod("showModal", originalShowModalDescriptor);
  restoreDialogMethod("close", originalCloseDescriptor);
});

function restoreDialogMethod(
  method: "showModal" | "close",
  descriptor: PropertyDescriptor | undefined,
): void {
  if (descriptor === undefined) {
    Reflect.deleteProperty(HTMLDialogElement.prototype, method);
    return;
  }
  Object.defineProperty(HTMLDialogElement.prototype, method, descriptor);
}

describe("PullRequestDescription", () => {
  it("renders safe GitHub-flavored Markdown and opens only an explicit same-host link", async () => {
    const user = userEvent.setup();
    const openExternalHttps = vi.fn(async () => true);
    desktop = installDesktopDouble({}, { openExternalHttps });

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

  it("gives a raw HTML anchor its own words and no empty control beside them", async () => {
    const user = userEvent.setup();
    const openExternalHttps = vi.fn(async () => true);
    desktop = installDesktopDouble({}, { openExternalHttps });

    const { container } = render(
      <PullRequestDescriptionPreview
        markdown={
          '\u{1F4A1} <a href="/centraldigital/patchdesk/new/master?filename=x" class="Link--inTextBlock">Add a `code-review` agent skill</a> or configure MCP servers.'
        }
        pullRequest={pullRequest}
      />,
    );

    const link = screen.getByRole("button", {
      name: "Add a code-review agent skill",
    });
    expect(screen.getAllByRole("button")).toHaveLength(1);
    expect(container.textContent).toContain(" or configure MCP servers.");

    await user.click(link);
    expect(openExternalHttps).toHaveBeenCalledWith(
      "https://github.com/centraldigital/patchdesk/new/master?filename=x",
    );
  });

  it("renders list-item text and inline Markdown", () => {
    render(
      <PullRequestDescriptionPreview
        markdown={
          "- **Changed** the route-planning solver.\n- Preserved [deterministic tie-breaking](https://github.com/centraldigital/patchdesk)."
        }
        pullRequest={pullRequest}
      />,
    );

    expect(screen.getByText("Changed")).toBeTruthy();
    expect(screen.getByText("the route-planning solver.")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "deterministic tie-breaking" }),
    ).toBeTruthy();
  });

  it("keys repeated inline nodes by position so React does not warn about duplicate keys", () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    try {
      render(
        <PullRequestDescriptionPreview
          markdown={
            "[Same](https://github.com/centraldigital/patchdesk) and [Same](https://github.com/centraldigital/patchdesk)\n\n`dup` and `dup`"
          }
          pullRequest={pullRequest}
        />,
      );

      expect(screen.getAllByRole("button", { name: "Same" })).toHaveLength(2);
      expect(screen.getAllByText("dup")).toHaveLength(2);
      for (const call of consoleError.mock.calls) {
        expect(String(call[0])).not.toMatch(/same key/i);
      }
    } finally {
      consoleError.mockRestore();
    }
  });

  it("states when the author did not provide a description", () => {
    render(<PullRequestDescription />);
    expect(
      screen.getByText("No description was provided on GitHub."),
    ).toBeTruthy();
  });

  it("preserves safe GitHub HTML and image content without executing arbitrary markup", async () => {
    const dataUri = "data:image/png;base64,AAAA";
    desktop = installDesktopDouble({
      "/v1/reviews/markdown-image": () => success({ dataUri }),
    });
    render(
      <PullRequestDescriptionPreview
        markdown={
          "<details open><summary>Context</summary><p>Details</p></details>\n\n![Architecture diagram](/centraldigital/patchdesk/raw/main/diagram.png)\n\n<script>window.bad = true</script>"
        }
        pullRequest={pullRequest}
        profileId="centraldigital"
      />,
    );

    expect(screen.getByText("Context")).toBeTruthy();
    expect(screen.getByText("Details")).toBeTruthy();
    const image = await screen.findByRole("img", {
      name: "Architecture diagram",
    });
    expect(image.getAttribute("src")).toBe(dataUri);
    expect(document.querySelector("script")).toBeNull();
    expect("bad" in window).toBe(false);
  });

  it("keeps the placeholder for an image no profile can be fetched as", () => {
    render(
      <PullRequestDescriptionPreview
        markdown="![Architecture diagram](/centraldigital/patchdesk/raw/main/diagram.png)"
        pullRequest={pullRequest}
      />,
    );

    expect(screen.getByText(/Architecture diagram/)).toBeTruthy();
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("keeps rendered Mermaid source and lightbox controls independent", async () => {
    const user = userEvent.setup();
    const originalGetBBox = Object.getOwnPropertyDescriptor(
      SVGElement.prototype,
      "getBBox",
    );
    const originalGetComputedTextLength = Object.getOwnPropertyDescriptor(
      SVGElement.prototype,
      "getComputedTextLength",
    );
    Object.defineProperty(SVGElement.prototype, "getBBox", {
      configurable: true,
      value: () => ({ x: 0, y: 0, width: 100, height: 30 }),
    });
    Object.defineProperty(SVGElement.prototype, "getComputedTextLength", {
      configurable: true,
      value: () => 100,
    });
    try {
      render(
        <PullRequestDescriptionPreview
          markdown={"```mermaid\ngraph TD\n  A[Start] --> B[Review]\n```"}
          pullRequest={pullRequest}
        />,
      );
      const diagramButton = await screen.findByRole("button", {
        name: "Mermaid diagram",
      });
      const summary = screen.getByText("Mermaid source");
      expect(summary.tagName).toBe("SUMMARY");
      expect(summary.closest("button")).toBeNull();
      summary.focus();
      await user.keyboard("{Enter}");
      expect(screen.queryByRole("dialog", { name: "Image viewer" })).toBeNull();
      await user.click(summary);
      const detailsElement = summary.parentElement;
      if (!(detailsElement instanceof HTMLDetailsElement)) {
        throw new Error(
          "expected the Mermaid summary's parent to be <details>",
        );
      }
      expect(detailsElement.open).toBe(true);
      diagramButton.focus();
      await user.keyboard("{Enter}");
      const dialog = screen.getByRole("dialog", { name: "Image viewer" });
      expect(dialog).toBeTruthy();
      fireEvent(dialog, new Event("cancel", { cancelable: true }));
      expect(screen.queryByRole("dialog", { name: "Image viewer" })).toBeNull();
    } finally {
      if (originalGetBBox === undefined) {
        Reflect.deleteProperty(SVGElement.prototype, "getBBox");
      } else {
        Object.defineProperty(SVGElement.prototype, "getBBox", originalGetBBox);
      }
      if (originalGetComputedTextLength === undefined) {
        Reflect.deleteProperty(SVGElement.prototype, "getComputedTextLength");
      } else {
        Object.defineProperty(
          SVGElement.prototype,
          "getComputedTextLength",
          originalGetComputedTextLength,
        );
      }
    }
  });

  it("renders Mermaid fences as a diagram surface with readable source fallback", async () => {
    render(
      <PullRequestDescriptionPreview
        markdown={"```mermaid\ngraph TD\n  A[Start] --> B[Review]\n```"}
        pullRequest={pullRequest}
      />,
    );

    expect(screen.getByLabelText("Mermaid diagram")).toBeTruthy();
    const source = screen.getByText("Mermaid source");
    expect(source.closest('[role="img"]')).toBeNull();
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
    class TestResizeObserver implements ResizeObserver {
      constructor(private readonly callback: ResizeObserverCallback) {}
      observe(): void {
        this.callback([], this);
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
        Reflect.deleteProperty(HTMLElement.prototype, "scrollHeight");
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
