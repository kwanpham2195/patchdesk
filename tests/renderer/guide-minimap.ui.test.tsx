// @vitest-environment jsdom
import { createRef } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it } from "vitest";
import { GuideMinimap } from "#src/renderer/src/components/guide-minimap";

afterEach(cleanup);

const groups = [
  {
    id: "g1",
    title: "Recovery",
    explanation: "Restore pending requests.",
    files: [{ id: "f1", path: "src/shared.ts" }],
  },
  {
    id: "g2",
    title: "Support",
    explanation: "Check recovered state.",
    reviewed: true,
    files: [{ id: "f1", path: "src/shared.ts" }],
  },
  {
    id: "others",
    title: "Others",
    explanation: "Ungrouped changes.",
    files: [{ id: "f2", path: "src/other.ts" }],
  },
];

function renderMinimap(navGroups = groups) {
  const root = createRef<HTMLDivElement>();
  render(
    <div role="region" aria-label="Outer app">
      <div role="region" aria-label="Guide viewport" data-guide-viewport>
        <div ref={root}>
          <GuideMinimap root={root} groups={navGroups} />
          {navGroups.map((group) => (
            <section
              key={group.id}
              aria-label={group.title}
              data-guide-minimap-group={group.id}
            >
              <h3>{group.title}</h3>
              <div
                data-guide-file={`${group.id}/${group.files[0]?.id}`}
                aria-label={`Appearance ${group.id}`}
                role="group"
              />
              <input
                aria-label={`Draft ${group.title}`}
                defaultValue="Unsaved text"
              />
            </section>
          ))}
        </div>
      </div>
    </div>,
  );
  const viewport = screen.getByRole("region", { name: "Guide viewport" });
  const outer = screen.getByRole("region", { name: "Outer app" });
  outer.scrollTop = 73;
  viewport.getBoundingClientRect = () => new DOMRect(0, 0, 800, 200);
  navGroups.forEach((group, index) => {
    screen.getByRole("region", { name: group.title }).getBoundingClientRect =
      () => new DOMRect(0, index * 200 - viewport.scrollTop, 800, 200);
  });
  navGroups.forEach((group, index) => {
    screen.getByRole("group", {
      name: `Appearance ${group.id}`,
    }).getBoundingClientRect = () =>
      new DOMRect(0, index * 200 + 60 - viewport.scrollTop, 800, 40);
  });
  const rail = screen.getByRole("button", { name: /^Jump to Guide group:/ });
  rail.getBoundingClientRect = () => new DOMRect(0, 20, 40, 160);
  fireEvent.scroll(viewport);
  return { viewport, outer, rail };
}

it("tracks the actual visible group and previews keyboard choices before jumping within Guide", async () => {
  const user = userEvent.setup();
  const { viewport, outer, rail } = renderMinimap();
  viewport.scrollTop = 250;
  fireEvent.scroll(viewport);
  expect(
    screen
      .getByRole("navigation", { name: "Guide groups" })
      .getAttribute("data-current-group"),
  ).toBe("g2");
  rail.focus();
  await user.keyboard("{Home}");
  expect(
    screen.getByRole("note", { name: "Guide preview Recovery" }),
  ).toBeDefined();
  expect(viewport.scrollTop).toBe(250);
  await user.keyboard("{Enter}");
  expect(viewport.scrollTop).toBe(0);
  fireEvent.scroll(viewport);
  expect(
    screen
      .getByRole("button", { name: "Previous Guide group" })
      .hasAttribute("disabled"),
  ).toBe(true);
  await user.keyboard("{ArrowDown} ");
  expect(viewport.scrollTop).toBe(200);
  await user.keyboard("{End}{Enter}");
  expect(viewport.scrollTop).toBe(400);
  fireEvent.scroll(viewport);
  expect(
    screen
      .getByRole("button", { name: "Next Guide group" })
      .hasAttribute("disabled"),
  ).toBe(true);
  expect(outer.scrollTop).toBe(73);
  expect(
    screen.getByRole("textbox", { name: "Draft Recovery" }),
  ).toHaveProperty("value", "Unsaved text");
});

it("selects the hovered last group and keeps its preview usable off the rail", () => {
  const { viewport, outer, rail } = renderMinimap();
  fireEvent.mouseMove(rail, { clientY: 180 });
  const preview = screen.getByRole("note", { name: "Guide preview Others" });
  fireEvent.mouseMove(preview, { clientY: 120 });
  expect(
    screen.getByRole("note", { name: "Guide preview Others" }),
  ).toBeDefined();
  fireEvent.click(rail, { clientY: 180 });
  expect(viewport.scrollTop).toBe(400);
  expect(outer.scrollTop).toBe(73);
});

it("moves keyboard focus into the preview and jumps to the selected repeated appearance without changing a draft", async () => {
  const user = userEvent.setup();
  const { viewport, outer, rail } = renderMinimap();
  rail.focus();
  await user.keyboard("{ArrowDown}{Tab}{Tab}");
  const preview = screen.getByRole("note", { name: "Guide preview Support" });
  expect(preview.contains(document.activeElement)).toBe(true);
  await user.click(screen.getByRole("button", { name: "src/shared.ts" }));
  expect(viewport.scrollTop).toBe(260);
  expect(outer.scrollTop).toBe(73);
  expect(
    screen.getByRole("textbox", { name: "Draft Recovery" }),
  ).toHaveProperty("value", "Unsaved text");
  await user.keyboard("{Escape}");
  expect(
    screen.queryByRole("note", { name: "Guide preview Support" }),
  ).toBeNull();
});

it("offers the ungrouped file destination in its preview", async () => {
  const user = userEvent.setup();
  const { viewport, rail } = renderMinimap();
  fireEvent.mouseMove(rail, { clientY: 180 });
  await user.click(screen.getByRole("button", { name: "src/other.ts" }));
  expect(viewport.scrollTop).toBe(460);
});

it("shows no navigation for an empty Guide", () => {
  render(<GuideMinimap root={createRef<HTMLDivElement>()} groups={[]} />);
  expect(screen.queryByRole("navigation", { name: "Guide groups" })).toBeNull();
});

it("keeps both adjacent actions unavailable for a single group while its destination remains usable", async () => {
  const user = userEvent.setup();
  const { rail, viewport } = renderMinimap(groups.slice(0, 1));
  expect(
    screen
      .getByRole("button", { name: "Previous Guide group" })
      .hasAttribute("disabled"),
  ).toBe(true);
  expect(
    screen
      .getByRole("button", { name: "Next Guide group" })
      .hasAttribute("disabled"),
  ).toBe(true);
  rail.focus();
  await user.keyboard("{End}");
  await user.click(screen.getByRole("button", { name: "src/shared.ts" }));
  expect(viewport.scrollTop).toBe(60);
  expect(screen.queryByRole("note", { name: /^Guide preview / })).toBeNull();
});

it("previews distant keyboard destinations in a large Guide before activating them", async () => {
  const user = userEvent.setup();
  const { rail, viewport, outer } = renderMinimap(
    Array.from({ length: 20 }, (_, index) => ({
      id: `g${index + 1}`,
      title: `Behavior ${index + 1}`,
      explanation: "Retained explanation.",
      files: [{ id: "f1", path: "src/shared.ts" }],
    })),
  );
  rail.focus();
  await user.keyboard("{End}");
  expect(
    screen.getByRole("note", { name: "Guide preview Behavior 20" }),
  ).toBeDefined();
  expect(viewport.scrollTop).toBe(0);
  await user.keyboard("{Enter}");
  expect(viewport.scrollTop).toBe(3800);
  expect(outer.scrollTop).toBe(73);
});

it("shows human picker labels and activates the selected group without opening Files", async () => {
  const user = userEvent.setup();
  const { viewport } = renderMinimap();
  const picker = screen.getByRole("combobox", { name: "Choose Guide group" });
  expect(picker.textContent).toContain("1. Recovery");
  await user.click(picker);
  await user.click(await screen.findByRole("option", { name: "3. Others" }));
  expect(viewport.scrollTop).toBe(400);
  fireEvent.scroll(viewport);
  expect(picker.textContent).toContain("3. Others");
  expect(screen.queryByRole("note", { name: /^Guide preview / })).toBeNull();
  await user.click(screen.getByRole("button", { name: "Files" }));
  expect(screen.getByRole("button", { name: "src/other.ts" })).toBeDefined();
});
