// @vitest-environment jsdom
import "./pierre-highlighter-mock";
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent, {
  PointerEventsCheckLevel,
} from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ReviewWorkbenchFlow } from "../../src/renderer/src/flows/review-workbench-flow";
import type { ReviewWorkbenchPatch } from "../../src/renderer/src/flows/use-review-observation";
import type { LocalDraftEntry } from "../../src/renderer/src/local-draft-contracts";
import type { WorkbenchResponse } from "../../src/renderer/src/renderer-contracts";
import { bridge, restoreBridge } from "./review-workbench-bridge";
import { projection } from "./review-workbench-fixtures";

afterEach(() => {
  cleanup();
  localStorage.clear();
  restoreBridge();
});

function filePatch(path: string): string {
  return `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+new\n`;
}

const patchView = { patchHash: "c".repeat(64), paths: [] };

function sharedReview(): WorkbenchResponse {
  const base = projection();
  return projection({
    session: {
      ...base.session,
      key: {
        ...base.session.key,
        source: { kind: "local_branch", branch: "feature", baseBranch: "main" },
      },
    },
    pullRequest: undefined,
    fullPatch: filePatch("src/combined.ts"),
    viewedPaths: [],
    patchViews: {
      combined: patchView,
      committed: patchView,
      uncommitted: patchView,
    },
  });
}

/** src/a.ts changed in every view: its snapshot text differs from HEAD, which differs from the merge base. */
function sharedReviewOnA(
  localDrafts: ReadonlyArray<LocalDraftEntry>,
): WorkbenchResponse {
  const base = sharedReview();
  const paths = { patchHash: "c".repeat(64), paths: ["src/a.ts"] };
  return {
    ...base,
    localDrafts: [...localDrafts],
    fullPatch: filePatch("src/a.ts"),
    patchViews: { combined: paths, committed: paths, uncommitted: paths },
  };
}

function uncommittedNote(): LocalDraftEntry {
  return {
    kind: "note",
    noteId: "note-1",
    sessionId: "session-a",
    view: "uncommitted",
    path: "src/a.ts",
    side: "new",
    startLine: 1,
    line: 1,
    text: "Guard the empty case.",
    state: "unchanged",
  };
}

/** Answers every view read with src/a.ts's one-line change, and records note adds. */
function viewsOfA(added: unknown[]) {
  bridge((input) => {
    if (input.path === "/v1/reviews/detect-updates")
      return { updatesAvailable: false };
    if (input.path === "/v1/reviews/local-patch-view") {
      const { view } = input.body as { readonly view: string };
      return {
        sessionId: "session-a",
        view,
        patch: filePatch("src/a.ts"),
        patchHash: "d".repeat(64),
        viewedPaths: [],
      };
    }
    if (input.path === "/v1/reviews/diff-file")
      return { state: "unavailable", reason: "path_unavailable" };
    if (input.path === "/v1/reviews/local-drafts/notes/add") {
      added.push(input.body);
      return { localDrafts: [] };
    }
    throw new Error(input.path);
  });
}

/** The flow over a shared local Review, applying its patches the way the Review screen does. */
function SharedReviewScreen({
  initial,
}: {
  readonly initial: WorkbenchResponse;
}): React.JSX.Element {
  const [workbench, setWorkbench] = useState(initial);
  return (
    <ReviewWorkbenchFlow
      workbench={workbench}
      onWorkbenchReplace={setWorkbench}
      onWorkbenchPatch={(patch) =>
        setWorkbench(
          (current) => ({ ...current, ...patch }) as WorkbenchResponse,
        )
      }
      onNavigationStateChange={vi.fn()}
    />
  );
}

// Pierre's CodeView suspends pointer events for 120 ms after a layout pass.
function setupCodeViewUser(): ReturnType<typeof userEvent.setup> {
  return userEvent.setup({ pointerEventsCheck: PointerEventsCheckLevel.Never });
}

async function showView(
  user: ReturnType<typeof userEvent.setup>,
  view: "Combined" | "Committed" | "Uncommitted",
): Promise<void> {
  await user.click(screen.getByRole("button", { name: view }));
  await waitFor(() =>
    expect(screen.queryByText(/^Loading the .* view/)).toBeNull(),
  );
  await screen.findAllByRole("button", { name: "Add note on src/a.ts" });
}

async function selectAddedLine(
  user: ReturnType<typeof userEvent.setup>,
): Promise<void> {
  const add = (
    await screen.findAllByRole("button", { name: "Add note on src/a.ts" })
  ).at(-1);
  if (add === undefined) throw new Error("missing Add note action");
  add.dataset.lineNumber = "1";
  add.dataset.lineSide = "additions";
  await user.click(add);
}

describe("ReviewWorkbenchFlow patch views", () => {
  it("shows the Committed patch on a switch and keeps its Viewed marks to that view", async () => {
    const saved: unknown[] = [];
    bridge((input) => {
      if (input.path === "/v1/reviews/detect-updates")
        return { updatesAvailable: false };
      if (input.path === "/v1/reviews/local-patch-view")
        return {
          sessionId: "session-a",
          view: "committed",
          patch: filePatch("src/committed.ts"),
          patchHash: "d".repeat(64),
          viewedPaths: [],
        };
      if (input.path === "/v1/reviews/viewed-files") {
        saved.push(input.body);
        return { paths: ["src/committed.ts"] };
      }
      if (input.path === "/v1/reviews/diff-file")
        return { state: "unavailable", reason: "path_unavailable" };
      throw new Error(input.path);
    });
    const patches: ReviewWorkbenchPatch[] = [];
    render(
      <ReviewWorkbenchFlow
        workbench={sharedReview()}
        onWorkbenchReplace={vi.fn()}
        onWorkbenchPatch={(patch) => patches.push(patch)}
        onNavigationStateChange={vi.fn()}
      />,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("tab", { name: "Diff" }));
    expect(screen.getByText(/Combined view/)).toBeTruthy();
    expect(
      screen
        .getByRole("button", { name: "Combined" })
        .getAttribute("aria-pressed"),
    ).toBe("true");

    await user.click(screen.getByRole("button", { name: "Committed" }));

    await waitFor(() =>
      expect(screen.getAllByText(/src\/committed\.ts/).length).toBeGreaterThan(
        0,
      ),
    );
    expect(screen.queryByText(/src\/combined\.ts/)).toBeNull();
    expect(screen.getByText(/Committed view/)).toBeTruthy();
    expect(
      screen
        .getByRole("button", { name: "Committed" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    await user.click(screen.getByRole("button", { name: "Mark all viewed" }));
    await waitFor(() => expect(saved).toHaveLength(1));
    expect(saved[0]).toMatchObject({
      view: "committed",
      paths: ["src/committed.ts"],
    });
    expect(patches).not.toContainEqual(
      expect.objectContaining({ viewedPaths: expect.anything() }),
    );
  });
});

describe("ReviewWorkbenchFlow notes across patch views", () => {
  // jsdom has no constructable stylesheets; Pierre's CodeView, which renders inline notes, only needs the call to exist.
  const stubbedReplaceSync = CSSStyleSheet.prototype.replaceSync === undefined;
  beforeEach(() => {
    if (stubbedReplaceSync)
      CSSStyleSheet.prototype.replaceSync = () => undefined;
  });
  afterEach(() => {
    if (stubbedReplaceSync)
      Reflect.deleteProperty(CSSStyleSheet.prototype, "replaceSync");
  });

  it("keeps a note's ID, text, and state across switches, inline where its tree is shown and absent otherwise", async () => {
    viewsOfA([]);
    const user = setupCodeViewUser();
    render(
      <SharedReviewScreen initial={sharedReviewOnA([uncommittedNote()])} />,
    );
    await user.click(screen.getByRole("tab", { name: "Diff" }));

    const inCombined = await screen.findByRole("article", {
      name: "Note on src/a.ts:1",
    });
    expect(inCombined.dataset.reviewLocalNote).toBe("note-1");
    expect(inCombined.textContent).toContain("Guard the empty case.");
    expect(inCombined.textContent).toContain("Unchanged");

    // Committed's new side is HEAD, whose src/a.ts differs from the snapshot the note was made on.
    await showView(user, "Committed");
    expect(
      screen.queryByRole("article", { name: "Note on src/a.ts:1" }),
    ).toBeNull();

    await showView(user, "Uncommitted");
    const inUncommitted = await screen.findByRole("article", {
      name: "Note on src/a.ts:1",
    });
    expect(inUncommitted.dataset.reviewLocalNote).toBe("note-1");
    expect(inUncommitted.textContent).toContain("Guard the empty case.");
    expect(inUncommitted.textContent).toContain("Unchanged");
  });

  it("offers an unsaved note as a recoverable draft after a switch, and the next selected line takes it and adds it on the shown view", async () => {
    const added: unknown[] = [];
    viewsOfA(added);
    const user = setupCodeViewUser();
    render(<SharedReviewScreen initial={sharedReviewOnA([])} />);
    await user.click(screen.getByRole("tab", { name: "Diff" }));
    await selectAddedLine(user);
    await user.type(
      within(screen.getByRole("region", { name: "Note composer" })).getByRole(
        "textbox",
        { name: "Note" },
      ),
      "Keep this across views.",
    );

    await showView(user, "Committed");
    expect(screen.queryByRole("region", { name: "Note composer" })).toBeNull();
    expect(screen.getByRole("region", { name: "Saved draft" })).toBeTruthy();
    await selectAddedLine(user);

    const composer = screen.getByRole("region", { name: "Note composer" });
    const textbox = within(composer).getByRole("textbox", { name: "Note" });
    await waitFor(() =>
      expect((textbox as HTMLTextAreaElement).value).toBe(
        "Keep this across views.",
      ),
    );
    expect(screen.queryByRole("region", { name: "Saved draft" })).toBeNull();
    await user.click(
      within(composer).getByRole("button", { name: "Add note" }),
    );
    await waitFor(() => expect(added).toHaveLength(1));
    expect(added[0]).toMatchObject({
      view: "committed",
      path: "src/a.ts",
      side: "new",
      startLine: 1,
      line: 1,
      text: "Keep this across views.",
    });
  });
});
