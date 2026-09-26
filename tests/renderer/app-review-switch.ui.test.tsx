// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";

import type { DesktopResponse } from "../../src/main/ipc-contract";
import { App } from "../../src/renderer/src/app";
import { ChangeIntentControl } from "../../src/renderer/src/components/change-intent-control";
import type { ReviewWorkbenchFlowProps } from "../../src/renderer/src/flows/review-workbench-flow";
import { useChangeIntent } from "../../src/renderer/src/flows/use-change-intent";
import type { WorkbenchResponse } from "../../src/renderer/src/renderer-contracts";
import { APP_BOOT_OPERATIONS, APP_BOOT_ROUTES } from "./app-boot-routes";
import {
  installDesktopDouble,
  success,
  type DesktopDouble,
} from "./fake-desktop-response";
import { asJsonBody } from "./inbox-flow-fixtures";
import { projection } from "./review-workbench-fixtures";

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
        source: { kind: "working_tree", branch: "main" },
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
});
