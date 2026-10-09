// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { buildGuideInventory, retainGuide } from "#src/domain/guide";
import { GuideReader } from "#src/renderer/src/components/guide-reader";
import { must } from "#tests/services/insight-run-fixture";

afterEach(cleanup);
const patchText =
  "diff --git a/src/a.ts b/src/a.ts\nold mode 100644\nnew mode 100755\ndiff --git a/assets/icon.png b/assets/icon.png\nBinary files a/assets/icon.png and b/assets/icon.png differ\n";
const inventory = must(buildGuideInventory(patchText));
const group = {
  title: "Recovery",
  explanation:
    "Read **pending state**. <script>alert(1)</script> ![unsafe](https://example.com/image.png)",
  files: [{ fileId: "f1", relevance: "Restores the saved request." }],
};
describe("Guide overview", () => {
  it("shows each membership, repeated files and exact Others while keeping rich model content inert", () => {
    const guide = must(
      retainGuide(
        {
          groups: [
            group,
            { ...group, title: "Support", explanation: "Checks recovery." },
          ],
        },
        { patchText, inventory },
      ),
    );
    const { container } = render(<GuideReader guide={guide} />);
    expect(screen.getByRole("heading", { name: "Recovery" })).toBeDefined();
    expect(screen.getByRole("heading", { name: "Support" })).toBeDefined();
    expect(
      screen.getByRole("heading", { name: "Others · 1 file" }),
    ).toBeDefined();
    expect(
      within(screen.getByRole("list", { name: "Recovery files" })).getAllByRole(
        "listitem",
      ),
    ).toHaveLength(1);
    expect(
      within(screen.getByRole("list", { name: "Support files" })).getAllByRole(
        "listitem",
      ),
    ).toHaveLength(1);
    expect(
      within(screen.getByRole("list", { name: "Others files" })).getAllByRole(
        "listitem",
      ),
    ).toHaveLength(1);
    expect(container.querySelector("script")).toBeNull();
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
  });
});
