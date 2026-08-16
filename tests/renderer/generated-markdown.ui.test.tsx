// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GeneratedMarkdown } from "../../src/renderer/src/components/generated-markdown";

afterEach(cleanup);

describe("GeneratedMarkdown", () => {
  it("renders code, emphasis, lists, and fences as inert local content", () => {
    const { container } = render(
      <GeneratedMarkdown
        markdown={[
          "Use `space_type` with **strict parsing**.",
          "",
          "- Run the focused test",
          "- Check the fallback",
          "",
          "```ts",
          "if (space_type === value) return true",
          "```",
        ].join("\n")}
      />,
    );

    expect(screen.getByText("space_type").tagName).toBe("CODE");
    expect(screen.getByText("strict parsing").tagName).toBe("STRONG");
    expect(container.querySelectorAll("li")).toHaveLength(2);
    expect(container.querySelector("pre code")?.textContent).toContain(
      "space_type === value",
    );
  });

  it("renders repeated identical tokens without duplicate-key warnings", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { container } = render(
      <GeneratedMarkdown
        markdown={[
          "Compare `system_suggestion` with `system_suggestion`.",
          "",
          "- `same` then `same`",
        ].join("\n")}
      />,
    );

    expect(container.querySelectorAll("code")).toHaveLength(4);
    const warnings = error.mock.calls.filter(([message]) =>
      String(message).includes("same key"),
    );
    expect(warnings).toHaveLength(0);
    error.mockRestore();
  });

  it("does not activate links, images, or raw HTML", () => {
    const { container } = render(
      <GeneratedMarkdown
        markdown={
          "[Open](https://example.com) ![remote](https://example.com/image.png) <script>window.bad = true</script>"
        }
      />,
    );

    expect(container.querySelector("a")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
    expect(screen.getByText("Open")).toBeTruthy();
    expect(screen.getByText("[Image omitted]")).toBeTruthy();
    expect(container.textContent).toContain(
      "<script>window.bad = true</script>",
    );
  });
});
