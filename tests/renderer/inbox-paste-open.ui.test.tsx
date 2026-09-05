// @vitest-environment jsdom
import { cleanup, fireEvent } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  installDesktopDouble,
  type DesktopDouble,
} from "./fake-desktop-response";
import {
  dashboard,
  inbox,
  renderInboxFlow,
  reviewRequestPaths,
  SHARED_INBOX_ROUTES,
} from "./inbox-flow-fixtures";
import { InboxFlowHarness } from "./inbox-flow-harness";

let desktop: DesktopDouble | undefined;

afterEach(() => {
  cleanup();
  desktop?.restore();
  desktop = undefined;
});

describe("InboxFlow paste behavior", () => {
  it("does not intercept a pull-request URL pasted on the document", () => {
    desktop = installDesktopDouble(SHARED_INBOX_ROUTES);
    renderInboxFlow(
      <InboxFlowHarness
        destination="dashboard"
        dashboard={dashboard}
        // SAFETY: InboxFlow reads only the fixture fields supplied here.
        inbox={inbox as never}
        state="success"
        refreshStatus="Current"
        onRefresh={vi.fn()}
        onSettings={vi.fn()}
        onOpenWorkbench={vi.fn()}
      />,
    );

    const allowed = fireEvent.paste(document, {
      clipboardData: {
        getData: () => "https://github.com/owner/repo/pull/1",
      },
    });

    expect(allowed).toBe(true);
    expect(reviewRequestPaths(desktop)).toEqual([]);
  });
});
