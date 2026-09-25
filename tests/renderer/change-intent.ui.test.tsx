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

import { ReviewWorkbenchFlow } from "../../src/renderer/src/flows/review-workbench-flow";
import type { WorkbenchResponse } from "../../src/renderer/src/renderer-contracts";
import {
  failure,
  installDesktopDouble,
  success,
} from "./fake-desktop-response";
import { callBody, callPath, projection } from "./review-workbench-fixtures";

const INTENT = "/v1/reviews/local-intent";
let restore: (() => void) | undefined;

afterEach(() => {
  cleanup();
  restore?.();
  restore = undefined;
});

const stored = {
  intent: { kind: "file", path: "docs/spec.md" },
  setting: { kind: "file", path: "docs/spec.md" },
} as const;

/** The flow over a working-tree Review with no Change intent, patched the way the Review screen does. */
function LocalReviewScreen(): React.JSX.Element {
  const [workbench, setWorkbench] = useState(() => {
    const base = projection();
    // SAFETY: fixture data in the wire shape `parseWorkbenchResponse` accepts; the working-tree source replaces the pull request fields.
    return projection({
      ...base,
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
  });
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

function installRoutes(
  intent: () => ReturnType<typeof success> | ReturnType<typeof failure>,
) {
  const double = installDesktopDouble({
    "/v1/reviews/detect-updates": () => success({ updatesAvailable: false }),
    "/v1/insight-providers": () => failure({ error: "storage" }, 503),
    "/v1/reviews/diff-file": () => failure({ error: "not_found" }, 404),
    [INTENT]: intent,
  });
  restore = double.restore;
  return double;
}

async function saveSpecFile() {
  const user = userEvent.setup({
    pointerEventsCheck: PointerEventsCheckLevel.Never,
  });
  await user.click(screen.getByRole("button", { name: "Change intent" }));
  const dialog = await screen.findByRole("dialog");
  await user.click(within(dialog).getByRole("tab", { name: "Spec file" }));
  await user.type(within(dialog).getByLabelText("Spec file"), " docs/spec.md ");
  await user.click(within(dialog).getByRole("button", { name: "Save" }));
  return dialog;
}

describe("Change intent on a local Review", () => {
  it("sets a spec file from the header dialog and shows its path in the header", async () => {
    const double = installRoutes(() => success({ changeIntent: stored }));
    render(<LocalReviewScreen />);

    const dialog = await saveSpecFile();

    expect(
      callBody(
        double.request.mock.calls.find(
          ([input]) => callPath(input) === INTENT,
        )?.[0],
      ),
    ).toMatchObject({ intent: { kind: "file", path: "docs/spec.md" } });
    await waitFor(() => expect(dialog.isConnected).toBe(false));
    expect(screen.getByText("Spec: docs/spec.md")).toBeTruthy();
  });

  it("keeps the dialog open with the refusal when the save is refused", async () => {
    installRoutes(() => failure({ error: "in_progress" }, 409));
    render(<LocalReviewScreen />);

    const dialog = await saveSpecFile();

    expect(await within(dialog).findByRole("alert")).toBeTruthy();
    expect(
      within(dialog).getByLabelText<HTMLInputElement>("Spec file").value,
    ).toBe(" docs/spec.md ");
  });
});
