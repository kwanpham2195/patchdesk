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
import { afterEach, describe, expect, it } from "vitest";

import { LocalNoteCard } from "../../src/renderer/src/components/local-note-card";
import { buildLocalNoteAnnotations } from "../../src/renderer/src/components/review-workbench-annotations";
import { ReviewWorkbenchFlow } from "../../src/renderer/src/flows/review-workbench-flow";
import { useLocalDrafts } from "../../src/renderer/src/flows/use-local-drafts";
import type { LocalDraftEntry } from "../../src/renderer/src/local-draft-contracts";
import type { WorkbenchResponse } from "../../src/renderer/src/renderer-contracts";
import {
  failure,
  installDesktopDouble,
  success,
} from "./fake-desktop-response";
import {
  callBody,
  callPath,
  projection,
  withoutViews,
} from "./review-workbench-fixtures";

const ADD = "/v1/reviews/local-drafts/notes/add";
const EDIT = "/v1/reviews/local-drafts/notes/edit";
const REMOVE = "/v1/reviews/local-drafts/notes/remove";
const RESOLVE = "/v1/reviews/local-drafts/resolve";
const REPLY = {
  draft: { noteId: "note-1" },
  status: "question" as const,
  text: "Should an empty list return 0?",
  repliedAt: "2026-09-30T00:00:00.000Z",
};
let restore: (() => void) | undefined;

afterEach(() => {
  cleanup();
  restore?.();
  restore = undefined;
});

function note(text: string): LocalDraftEntry {
  return {
    kind: "note",
    noteId: "note-1",
    sessionId: "session-a",
    view: "combined",
    path: "src/a.ts",
    side: "new",
    startLine: 1,
    line: 1,
    text,
  };
}

function workingTreeReview(): WorkbenchResponse {
  const base = projection();
  // SAFETY: fixture data in the wire shape `parseWorkbenchResponse` accepts; the working-tree source replaces the pull request fields.
  return projection({
    ...base,
    session: {
      ...base.session,
      key: {
        ...base.session.key,
        source: {
          kind: "local_branch",
          branch: "main",
          baseRef: "refs/heads/develop",
        },
      },
    },
    pullRequest: undefined,
    localDrafts: [],
  } as never);
}

/** The flow over a working-tree Review, applying its patches the way the Review screen does. */
function LocalReviewScreen(): React.JSX.Element {
  const [workbench, setWorkbench] = useState(workingTreeReview);
  return (
    <ReviewWorkbenchFlow
      workbench={workbench}
      onWorkbenchReplace={setWorkbench}
      onWorkbenchPatch={(patch) =>
        setWorkbench(
          (current) => ({ ...current, ...patch }) as WorkbenchResponse,
        )
      }
      onNavigationStateChange={() => undefined}
    />
  );
}

/** A local Review's inline note cards, built and wired the way the Diff tab builds them, over the real Local draft hook. */
function InlineNotes({
  initial = () =>
    projection({
      ...workingTreeReview(),
      localDrafts: [note("Guard the empty case.")],
    }),
}: {
  readonly initial?: () => WorkbenchResponse;
}): React.JSX.Element {
  const [workbench, setWorkbench] = useState(initial);
  const localDrafts = useLocalDrafts({
    workbench,
    view: undefined,
    onWorkbenchPatch: (patch) =>
      setWorkbench(
        (current) => ({ ...current, ...patch }) as WorkbenchResponse,
      ),
  });
  return (
    <>
      {buildLocalNoteAnnotations(
        workbench.localDrafts ?? [],
        localDrafts ?? {},
        withoutViews(workbench.session.id),
      ).map((annotation) =>
        annotation.localNote === undefined ? null : (
          <LocalNoteCard key={annotation.id} {...annotation.localNote} />
        ),
      )}
    </>
  );
}

function notesCalls(double: ReturnType<typeof installDesktopDouble>) {
  return double.request.mock.calls.flatMap(([input]) =>
    [ADD, EDIT, REMOVE].includes(callPath(input) ?? "")
      ? [[callPath(input), callBody(input)]]
      : [],
  );
}

describe("Maintainer notes on a local Review", () => {
  it("adds a note from the Diff composer and lists it in the Notes list, which removes it", async () => {
    const double = installDesktopDouble({
      "/v1/reviews/detect-updates": () => success({ updatesAvailable: false }),
      "/v1/insight-providers": () => failure({ error: "storage" }, 503),
      // Context hydration is not under test; an unreadable file keeps the patch as it is.
      "/v1/reviews/diff-file": () => failure({ error: "not_found" }, 404),
      [ADD]: () => success({ localDrafts: [note("Guard the empty case.")] }),
      [REMOVE]: () => success({ localDrafts: [] }),
    });
    restore = double.restore;
    const user = userEvent.setup({
      pointerEventsCheck: PointerEventsCheckLevel.Never,
    });
    render(<LocalReviewScreen />);

    await user.click(screen.getByRole("tab", { name: "Diff" }));
    const addNote = (
      await screen.findAllByRole("button", { name: "Add note on src/a.ts" })
    ).at(-1);
    if (addNote === undefined) throw new Error("missing Add note action");
    await user.click(addNote);
    const composer = screen.getByRole("region", { name: "Note composer" });
    await user.type(
      within(composer).getByRole("textbox", { name: "Note" }),
      "Guard the empty case.",
    );
    await user.click(
      within(composer).getByRole("button", { name: "Add note" }),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("region", { name: "Note composer" }),
      ).toBeNull(),
    );
    await user.click(screen.getByRole("tab", { name: /^Notes/ }));
    const list = await screen.findByRole("list", { name: "Local drafts" });
    expect(list.textContent).toContain("Guard the empty case.");
    await user.click(
      within(list).getByRole("button", {
        name: "Remove note at src/a.ts:1 from drafts",
      }),
    );
    await waitFor(() =>
      expect(screen.queryByRole("list", { name: "Local drafts" })).toBeNull(),
    );

    expect(notesCalls(double)).toEqual([
      [
        ADD,
        {
          profileId: "profile",
          reviewId: "review-42",
          sessionId: "session-a",
          path: "src/a.ts",
          startLine: 1,
          line: 1,
          side: "new",
          text: "Guard the empty case.",
        },
      ],
      [
        REMOVE,
        {
          profileId: "profile",
          reviewId: "review-42",
          sessionId: "session-a",
          noteId: "note-1",
        },
      ],
    ]);
  });

  it("edits a note in place, keeps the text when the save is refused, and removes it", async () => {
    const edits = [
      failure({ error: "in_progress" }, 409),
      success({ localDrafts: [note("Return early when empty.")] }),
    ];
    const double = installDesktopDouble({
      [EDIT]: () => edits.shift() ?? failure({ error: "storage" }, 503),
      [REMOVE]: () => success({ localDrafts: [] }),
    });
    restore = double.restore;
    const user = userEvent.setup();
    render(<InlineNotes />);
    const card = screen.getByRole("article", { name: "Note on src/a.ts:1" });

    await user.click(within(card).getByRole("button", { name: "Edit note" }));
    const editor = within(card).getByRole("textbox", { name: "Note" });
    await user.clear(editor);
    await user.type(editor, "Return early when empty.");
    await user.click(within(card).getByRole("button", { name: "Save note" }));
    await waitFor(() =>
      expect(editor.getAttribute("aria-invalid")).toBe("true"),
    );
    expect((editor as HTMLTextAreaElement).value).toBe(
      "Return early when empty.",
    );
    await user.keyboard("{Meta>}{Enter}{/Meta}");
    await waitFor(() =>
      expect(within(card).queryByRole("textbox", { name: "Note" })).toBeNull(),
    );
    expect(card.textContent).toContain("Return early when empty.");
    await user.click(within(card).getByRole("button", { name: "Remove note" }));
    await waitFor(() =>
      expect(
        screen.queryByRole("article", { name: "Note on src/a.ts:1" }),
      ).toBeNull(),
    );

    const edit = {
      profileId: "profile",
      reviewId: "review-42",
      sessionId: "session-a",
      noteId: "note-1",
      text: "Return early when empty.",
    };
    expect(notesCalls(double)).toEqual([
      [EDIT, edit],
      [EDIT, edit],
      [
        REMOVE,
        {
          profileId: "profile",
          reviewId: "review-42",
          sessionId: "session-a",
          noteId: "note-1",
        },
      ],
    ]);
  });

  it("shows the agent's reply on a note's card, and Resolve and Reopen there mark the note in place (#688)", async () => {
    const open = note("Guard the empty case.");
    const resolves = [
      success({
        localDrafts: [{ ...open, resolvedAt: "2026-09-30T01:00:00.000Z" }],
        localDraftReplies: [REPLY],
      }),
      success({ localDrafts: [open], localDraftReplies: [REPLY] }),
    ];
    const double = installDesktopDouble({
      [RESOLVE]: () => resolves.shift() ?? failure({ error: "storage" }, 503),
    });
    restore = double.restore;
    const user = userEvent.setup();
    render(
      <InlineNotes
        initial={() =>
          projection({
            ...workingTreeReview(),
            localDrafts: [open],
            localDraftReplies: [REPLY],
          })
        }
      />,
    );
    const card = screen.getByRole("article", { name: "Note on src/a.ts:1" });

    const reply = within(card).getByRole("group", { name: "Agent reply" });
    expect(
      within(reply).getByText("Should an empty list return 0?"),
    ).toBeTruthy();
    expect(within(card).queryByText("Resolved")).toBeNull();
    await user.click(
      within(card).getByRole("button", { name: "Resolve note" }),
    );
    await within(card).findByRole("button", { name: "Reopen note" });
    expect(within(card).getByText("Resolved")).toBeTruthy();
    expect(
      within(card).getByRole("group", { name: "Agent reply" }),
    ).toBeTruthy();
    await user.click(within(card).getByRole("button", { name: "Reopen note" }));
    await within(card).findByRole("button", { name: "Resolve note" });
    expect(within(card).queryByText("Resolved")).toBeNull();

    const resolveCalls = double.request.mock.calls.flatMap(([input]) =>
      callPath(input) === RESOLVE ? [callBody(input)] : [],
    );
    expect(resolveCalls).toEqual([
      {
        profileId: "profile",
        reviewId: "review-42",
        sessionId: "session-a",
        draft: { noteId: "note-1" },
        resolved: true,
      },
      {
        profileId: "profile",
        reviewId: "review-42",
        sessionId: "session-a",
        draft: { noteId: "note-1" },
        resolved: false,
      },
    ]);
  });

  it("keeps a resolved, answered note's card on a merged Review, without Resolve or Reopen (#688)", () => {
    const base = workingTreeReview();
    render(
      <InlineNotes
        initial={() =>
          projection({
            ...base,
            review: { ...base.review, status: "merged" },
            localDrafts: [
              {
                ...note("Guard the empty case."),
                resolvedAt: "2026-09-30T01:00:00.000Z",
              },
            ],
            localDraftReplies: [REPLY],
          })
        }
      />,
    );
    const card = screen.getByRole("article", { name: "Note on src/a.ts:1" });

    expect(within(card).getByText("Resolved")).toBeTruthy();
    expect(
      within(card).getByRole("group", { name: "Agent reply" }).textContent,
    ).toContain("Should an empty list return 0?");
    expect(
      within(card).queryByRole("button", { name: /^(Resolve|Reopen) note$/ }),
    ).toBeNull();
  });
});
