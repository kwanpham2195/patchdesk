// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { PullRequestDescription } from "../../src/renderer/src/components/pull-request-description";

describe("PullRequestDescription", () => {
  it("renders GitHub-flavored Markdown without executing raw HTML or unsafe links", () => {
    render(<PullRequestDescription markdown={"# Context\n\n**Keep this**. [Docs](https://example.com/docs)\n\n<script>window.bad = true</script>\n\n[javascript](javascript:alert(1))"} />);

    expect(screen.getByRole("heading", { name: "Context" })).toBeTruthy();
    expect(screen.getByText("Keep this")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Docs" }).getAttribute("href")).toBe("https://example.com/docs");
    expect(document.querySelector("script")).toBeNull();
    expect(screen.queryByRole("link", { name: "javascript" })).toBeNull();
  });

  it("states when the author did not provide a description", () => {
    render(<PullRequestDescription />);
    expect(screen.getByText("No description was provided on GitHub.")).toBeTruthy();
  });
});
