// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useState } from "react";
import userEvent from "@testing-library/user-event";

import {
  FileChangeCounts,
  FileHeaderRow,
} from "#src/renderer/src/components/review-diff-file-header";

afterEach(cleanup);

const stats = { path: "src/a.ts", additions: 3, deletions: 1 };

it("keeps Diff's Viewed and expansion toggle coupled through the shared checkbox", async () => {
  function Header(): React.JSX.Element {
    const [collapsed, setCollapsed] = useState(false);
    return (
      <FileHeaderRow
        file={{ name: "src/a.ts", type: "change" }}
        stats={<FileChangeCounts stats={stats} />}
        toggle={{ collapsed, onToggle: () => setCollapsed((value) => !value) }}
      />
    );
  }
  const user = userEvent.setup();
  render(<Header />);
  await user.click(
    screen.getByRole("checkbox", {
      name: "Mark file src/a.ts as viewed",
      checked: false,
    }),
  );
  expect(
    screen.getByRole("checkbox", { name: "Show file src/a.ts", checked: true }),
  ).toBeDefined();
  await user.click(
    screen.getByRole("button", { name: "Expand file src/a.ts" }),
  );
  expect(
    screen.getByRole("checkbox", {
      name: "Mark file src/a.ts as viewed",
      checked: false,
    }),
  ).toBeDefined();
});

describe("FileChangeCounts", () => {
  it("badges a file that Analysis findings cite with their count and highest severity", () => {
    render(
      <FileChangeCounts stats={stats} findings={{ count: 2, highest: "P1" }} />,
    );
    const badge = screen.getByRole("img", { name: "2 findings, highest P1" });
    expect(badge.textContent).toBe("2");
    expect(screen.getByLabelText("3 additions, 1 deletions")).toBeTruthy();
  });

  it("shows no badge for a file without findings", () => {
    render(<FileChangeCounts stats={stats} />);
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.getByLabelText("3 additions, 1 deletions")).toBeTruthy();
  });
});
