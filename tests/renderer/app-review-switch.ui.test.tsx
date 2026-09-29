// @vitest-environment jsdom
import "./pierre-highlighter-mock";
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent, {
  PointerEventsCheckLevel,
} from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";

import type { DesktopResponse } from "../../src/main/ipc-contract";
import { App } from "../../src/renderer/src/app";
import { ChangeIntentControl } from "../../src/renderer/src/components/change-intent-control";
import {
  ReviewWorkbenchFlow,
  type ReviewWorkbenchFlowProps,
} from "../../src/renderer/src/flows/review-workbench-flow";
import { useChangeIntent } from "../../src/renderer/src/flows/use-change-intent";
import type { WorkbenchResponse } from "../../src/renderer/src/renderer-contracts";
import { APP_BOOT_OPERATIONS, APP_BOOT_ROUTES } from "./app-boot-routes";
import {
  failure,
  installDesktopDouble,
  success,
  type DesktopDouble,
} from "./fake-desktop-response";
import { asJsonBody, inbox as inboxWithRow } from "./inbox-flow-fixtures";
import { callPath, projection } from "./review-workbench-fixtures";

let installed: DesktopDouble | undefined;

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  installed?.restore();
  installed = undefined;
});

const profile = {
  id: "profile",
  label: "Profile",
  githubHost: "github.com",
  ghAccount: "fixture",
  repos: [{ host: "github.com", owner: "acme", repo: "widgets" }],
};
const intentText = "Reject a negative total.";

/** A working-tree Review `id` with no Change intent. */
function localReview(id: string): WorkbenchResponse {
  const base = projection();
  // SAFETY: fixture data in the wire shape `parseWorkbenchResponse` accepts; the working-tree source replaces the pull request fields.
  return projection({
    ...base,
    review: { ...base.review, id },
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
    changeIntent: null,
  } as never);
}

describe("App Review switch", () => {
  it("closes the Change intent editor and keeps a save that settles later off the next Review", async () => {
    const user = userEvent.setup();
    let answer: (response: DesktopResponse) => void = () => undefined;
    let switchReview: (next: WorkbenchResponse) => void = () => undefined;
    window.localStorage.setItem("patchdesk.destination", "workbench:review-a");
    installed = installDesktopDouble(
      {
        ...APP_BOOT_ROUTES,
        "/v1/profiles": () => success([profile]),
        "/v1/inbox": () =>
          success({
            profile,
            inbox: {
              state: "open",
              pageSize: 25,
              rows: [],
              repositories: [],
              dataFreshness: "fresh",
            },
          }),
        "/v1/reviews/load": () => success(asJsonBody(localReview("review-a"))),
        "/v1/reviews/local-intent": () =>
          new Promise<DesktopResponse>((resolve) => {
            answer = resolve;
          }),
      },
      { operations: APP_BOOT_OPERATIONS },
    );
    // The real Change intent control and hook, mounted where the workbench route mounts its flow.
    const IntentWorkbench = (props: ReviewWorkbenchFlowProps) => {
      const controls = useChangeIntent(props);
      switchReview = props.onWorkbenchReplace;
      return (
        <>
          <h1>{props.workbench.review.id}</h1>
          {controls === undefined ? null : (
            <ChangeIntentControl controls={controls} editable />
          )}
        </>
      );
    };
    render(
      <App
        reviewWorkbenchLoader={async () => ({ default: IntentWorkbench })}
      />,
    );

    await screen.findByRole("heading", { name: "review-a" });
    await user.click(screen.getByRole("button", { name: "Change intent" }));
    await user.type(screen.getByLabelText("Intent"), intentText);
    await user.click(screen.getByRole("button", { name: "Save" }));
    act(() => switchReview(localReview("review-b")));
    await screen.findByRole("heading", { name: "review-b" });
    expect(screen.queryByRole("dialog")).toBeNull();
    await act(async () => {
      answer(
        success({
          changeIntent: {
            intent: { kind: "text", markdown: intentText },
            setting: { kind: "text", sha256: "a".repeat(64) },
          },
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(screen.getByRole("heading", { name: "review-b" })).not.toBeNull();
    expect(screen.queryByText(intentText)).toBeNull();
  });

  it("holds a Review switch behind the leave dialog while a Change intent edit is kept, and Discard drops the edit", async () => {
    const user = userEvent.setup({
      pointerEventsCheck: PointerEventsCheckLevel.Never,
    });
    window.localStorage.setItem("patchdesk.destination", "workbench:review-a");
    installed = installDesktopDouble(
      {
        ...APP_BOOT_ROUTES,
        "/v1/profiles": () => success([profile]),
        "/v1/inbox": () =>
          success({
            ...inboxWithRow,
            profile,
            inbox: { ...inboxWithRow.inbox, state: "open", pageSize: 25 },
          }),
        "/v1/reviews/leave": () => success(null),
        "/v1/reviews/load": () => success(asJsonBody(localReview("review-a"))),
        "/v1/reviews/open": () => success(asJsonBody(localReview("review-b"))),
        "/v1/reviews/detect-updates": () =>
          success({ updatesAvailable: false }),
        "/v1/insight-providers": () => failure({ error: "storage" }, 503),
        "/v1/reviews/diff-file": () => failure({ error: "not_found" }, 404),
      },
      { operations: APP_BOOT_OPERATIONS },
    );
    render(
      <App
        reviewWorkbenchLoader={async () => ({ default: ReviewWorkbenchFlow })}
      />,
    );
    await user.click(
      await screen.findByRole("button", { name: "Change intent" }),
    );
    await user.type(
      within(await screen.findByRole("dialog")).getByLabelText("Intent"),
      intentText,
    );
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByText("Unsaved edit")).toBeTruthy();

    await user.keyboard("{Meta>}k{/Meta}");
    await user.type(
      await screen.findByRole("combobox", { name: "Search views and actions" }),
      "acme/widgets#43",
    );
    await user.click(
      screen.getByRole("option", { name: "Open acme/widgets#43" }),
    );
    await user.click(
      await screen.findByRole("button", { name: "Discard changes and leave" }),
    );

    await waitFor(() =>
      expect(
        installed?.request.mock.calls.some(
          ([request]) => callPath(request) === "/v1/reviews/open",
        ),
      ).toBe(true),
    );
    await waitFor(() => expect(screen.queryByText("Unsaved edit")).toBeNull());
    await user.click(screen.getByRole("button", { name: "Change intent" }));
    expect(
      within(
        await screen.findByRole("dialog"),
      ).getByLabelText<HTMLTextAreaElement>("Intent").value,
    ).toBe("");
  });
});
