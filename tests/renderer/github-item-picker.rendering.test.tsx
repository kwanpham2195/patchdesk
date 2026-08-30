// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ForbiddenReason } from "../../src/domain/github-forbidden-reason";
import { AssigneePicker } from "../../src/renderer/src/components/assignee-picker";
import { LabelPicker } from "../../src/renderer/src/components/label-picker";
import { ReviewerPicker } from "../../src/renderer/src/components/reviewer-picker";
import { forbiddenCopy } from "../../src/renderer/src/github-read-failure-copy";
import type {
  AssignableUserListResponse,
  RepositoryLabelListResponse,
  ReviewerListResponse,
} from "../../src/renderer/src/renderer-contracts";

/**
 * The rendering contract the three rail pickers share, asserted against each
 * mounted component rather than against `useGithubItemPicker`'s own fixture.
 *
 * `use-github-item-picker.test.ts` proves the state machine *decides*
 * correctly. It cannot prove any picker still *shows* what was decided: it
 * runs on its own `projectReady`/`keyOf`/`describeWriteFailure`, so a picker
 * that stopped rendering `picker.writeError`, dropped GitHub's specific
 * forbidden reason, told a permitted account its writes may be refused, or
 * lost its own `totalCount` projection would leave that suite green. Each
 * promise below is therefore asserted once per picker, from the DOM, through
 * the markers the components carry (`data-slot="picker-…"`) rather than
 * through sentences of copy (AGENTS.md Testing).
 *
 * What is picker-specific — the ten-assignee cap, the reviewer suggestion
 * groups, each surface's own command shape — stays in that picker's own
 * `.ui.test.tsx`.
 */

afterEach(() => cleanup());

// A tiny, obviously-fake `data:` URI, enough for `Avatar` to take its
// `<img>` branch. Only the two people pickers carry avatars.
const FIXTURE_AVATAR_DATA_URI = "data:image/png;base64,AAAA";

/** What the picker's list fetch resolves to (or throws) for one case. */
type ReadScenario =
  | {
      readonly read: "ready";
      readonly permission?: "permitted" | "denied" | "unknown";
      /** Left out to exercise each picker's own "fall back to the rows returned" projection. */
      readonly totalCount?: number | undefined;
    }
  | { readonly read: "github_forbidden"; readonly reason?: ForbiddenReason }
  | { readonly read: "throws" };

const READY: ReadScenario = { read: "ready" };

/** The `state`/`permission`/`forbiddenReason` fields every list response shares. */
type SharedListFields = {
  readonly state: "ready" | "github_forbidden" | "github_read";
  readonly permission?: "permitted" | "denied" | "unknown";
  readonly forbiddenReason?: ForbiddenReason;
};

function commonFields(scenario: ReadScenario): SharedListFields {
  if (scenario.read === "ready")
    return { state: "ready", permission: scenario.permission ?? "permitted" };
  if (scenario.read === "github_forbidden") {
    if (scenario.reason === undefined) return { state: "github_forbidden" };
    return { state: "github_forbidden", forbiddenReason: scenario.reason };
  }
  // Unreachable: the `throws` scenario rejects before a response is built.
  return { state: "github_read" };
}

/** GitHub's own total, when this scenario put one on the wire at all. */
function wireTotalCount(scenario: ReadScenario): number | undefined {
  return scenario.read === "ready" ? scenario.totalCount : undefined;
}

/** One picker under the shared contract: how to mount it, and the two rows its fixture reports. */
type PickerCase = {
  readonly picker: string;
  readonly trigger: string;
  /** The row the fixture reports as already attached — the remove path. */
  readonly attachedRow: string;
  /** The row the fixture reports as available — the add path. */
  readonly detachedRow: string;
  /** How many rows the ready fixture returns, so truncation can be read against it. */
  readonly rowsReturned: number;
  readonly mount: (scenario: ReadScenario, write: () => Promise<void>) => void;
};

const assigneeCase: PickerCase = {
  picker: "AssigneePicker",
  trigger: "Manage assignees",
  attachedRow: "octocat",
  detachedRow: "hubot",
  rowsReturned: 2,
  mount: (scenario, write) => {
    render(
      <AssigneePicker
        attachedAssignees={["octocat"]}
        actions={{
          fetchAssignableUsers:
            async (): Promise<AssignableUserListResponse> => {
              if (scenario.read === "throws") throw new Error("offline");
              const response = {
                ...commonFields(scenario),
                users: [
                  {
                    id: "U_bug",
                    login: "octocat",
                    avatarDataUri: FIXTURE_AVATAR_DATA_URI,
                  },
                  { id: "U_docs", login: "hubot" },
                ],
              };
              const totalCount = wireTotalCount(scenario);
              if (totalCount === undefined) return response;
              return { ...response, totalCount };
            },
          addAssignees: write,
          removeAssignees: write,
        }}
      />,
    );
  },
};

const labelCase: PickerCase = {
  picker: "LabelPicker",
  trigger: "Manage labels",
  attachedRow: "bug",
  detachedRow: "documentation",
  rowsReturned: 2,
  mount: (scenario, write) => {
    render(
      <LabelPicker
        attachedLabels={[{ name: "bug", color: "d73a4a" }]}
        actions={{
          fetchLabels: async (): Promise<RepositoryLabelListResponse> => {
            if (scenario.read === "throws") throw new Error("offline");
            const response = {
              ...commonFields(scenario),
              labels: [
                { id: "LA_bug", name: "bug", color: "d73a4a" },
                { id: "LA_docs", name: "documentation", color: "0075ca" },
              ],
            };
            const totalCount = wireTotalCount(scenario);
            if (totalCount === undefined) return response;
            return { ...response, totalCount };
          },
          addLabels: write,
          removeLabels: write,
        }}
      />,
    );
  },
};

const reviewerCase: PickerCase = {
  picker: "ReviewerPicker",
  trigger: "Manage reviewers",
  attachedRow: "octocat",
  detachedRow: "hubot",
  rowsReturned: 2,
  mount: (scenario, write) => {
    render(
      <ReviewerPicker
        attachedReviewers={["octocat"]}
        actions={{
          fetchReviewers: async (): Promise<ReviewerListResponse> => {
            if (scenario.read === "throws") throw new Error("offline");
            const response = {
              ...commonFields(scenario),
              candidates: [
                {
                  id: "U_bug",
                  login: "octocat",
                  avatarDataUri: FIXTURE_AVATAR_DATA_URI,
                },
                { id: "U_docs", login: "hubot" },
              ],
            };
            const candidatesTotalCount = wireTotalCount(scenario);
            if (candidatesTotalCount === undefined) return response;
            return { ...response, candidatesTotalCount };
          },
          requestReviewers: write,
          removeReviewers: write,
        }}
      />,
    );
  },
};

const pickers = [assigneeCase, labelCase, reviewerCase];

const slot = (name: string): Element | null =>
  document.querySelector(`[data-slot="${name}"]`);

async function openPicker(
  user: ReturnType<typeof userEvent.setup>,
  trigger: string,
) {
  await user.click(screen.getByRole("button", { name: trigger }));
}

describe.each(pickers)(
  "$picker — the rendering contract every rail picker keeps",
  ({ trigger, attachedRow, detachedRow, rowsReturned, mount }) => {
    it("reports a failed write in an alert that names the item, with its own sentence for each direction", async () => {
      const user = userEvent.setup();
      const write = vi.fn(async () => {
        throw new Error("GitHub refused");
      });
      mount(READY, write);
      await openPicker(user, trigger);

      await user.click(
        await screen.findByRole("checkbox", {
          name: detachedRow,
        }),
      );
      const added = await screen.findByRole("alert");
      expect(added.getAttribute("data-slot")).toBe("picker-write-error");
      const addFailure = added.textContent ?? "";
      expect(addFailure).toContain(detachedRow);

      await user.click(screen.getByRole("checkbox", { name: attachedRow }));
      let removeFailure = "";
      await waitFor(() => {
        removeFailure = slot("picker-write-error")?.textContent ?? "";
        expect(removeFailure).toContain(attachedRow);
      });

      // The two sentences must differ in more than the item's own name: a
      // single generic sentence for both directions is the regression here.
      const anonymised = (sentence: string, item: string) =>
        sentence.replaceAll(item, "«item»");
      expect(anonymised(addFailure, detachedRow)).not.toBe(
        anonymised(removeFailure, attachedRow),
      );
      expect(write).toHaveBeenCalledTimes(2);
    });

    it("shows scoped Updating feedback beside only the pending row", async () => {
      const user = userEvent.setup();
      let settle: () => void = () => undefined;
      const write = vi.fn(
        async () =>
          await new Promise<void>((resolve) => {
            settle = resolve;
          }),
      );
      mount(READY, write);
      await openPicker(user, trigger);
      await user.click(
        await screen.findByRole("checkbox", { name: detachedRow }),
      );
      expect(
        document.querySelectorAll('[data-slot="picker-item-pending"]'),
      ).toHaveLength(1);
      expect(
        screen
          .getByRole("checkbox", { name: new RegExp(`^${detachedRow}`) })
          .getAttribute("aria-disabled"),
      ).toBe("true");
      expect(
        screen
          .getByRole("checkbox", { name: attachedRow })
          .getAttribute("aria-disabled"),
      ).not.toBe("true");
      settle();
      await waitFor(() =>
        expect(
          document.querySelector('[data-slot="picker-item-pending"]'),
        ).toBeNull(),
      );
    });

    it("keeps GitHub's own reason for a forbidden read, and says so when there is none", async () => {
      const user = userEvent.setup();
      const write = vi.fn(async () => undefined);
      mount({ read: "github_forbidden", reason: "saml" }, write);
      await openPicker(user, trigger);
      const withReason = (await screen.findByRole("alert")).textContent;
      expect(withReason).toBe(forbiddenCopy("saml"));
      cleanup();

      mount({ read: "github_forbidden" }, write);
      await openPicker(user, trigger);
      const withoutReason = (await screen.findByRole("alert")).textContent;
      expect(withoutReason).toBe(forbiddenCopy(undefined));
      expect(withReason).not.toBe(withoutReason);
    });

    it("reads a thrown fetch as a read failure, not an empty list", async () => {
      const user = userEvent.setup();
      mount(
        { read: "throws" },
        vi.fn(async () => undefined),
      );
      await openPicker(user, trigger);
      await screen.findByRole("alert");
      expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
    });

    it("warns only an unconfirmed account that a change may be refused, never a permitted one", async () => {
      const user = userEvent.setup();
      const write = vi.fn(async () => undefined);
      mount({ read: "ready", permission: "permitted" }, write);
      await openPicker(user, trigger);
      await screen.findByRole("checkbox", { name: attachedRow });
      expect(slot("picker-permission-caveat")).toBeNull();
      expect(slot("picker-permission-denied")).toBeNull();
      cleanup();

      mount({ read: "ready", permission: "unknown" }, write);
      await openPicker(user, trigger);
      await screen.findByRole("checkbox", { name: attachedRow });
      expect(slot("picker-permission-caveat")).toBeTruthy();
      expect(slot("picker-permission-denied")).toBeNull();
    });

    it("shows the truncation note only when GitHub's total exceeds the rows returned, and names both numbers", async () => {
      const user = userEvent.setup();
      const write = vi.fn(async () => undefined);
      // No `totalCount` on the wire: each picker falls back to the rows it
      // returned, so nothing claims to be hidden.
      mount(READY, write);
      await openPicker(user, trigger);
      await screen.findByRole("checkbox", { name: attachedRow });
      expect(slot("picker-truncation")).toBeNull();
      cleanup();

      mount({ read: "ready", totalCount: rowsReturned + 3 }, write);
      await openPicker(user, trigger);
      await screen.findByRole("checkbox", { name: attachedRow });
      const truncation = slot("picker-truncation")?.textContent ?? "";
      expect(truncation).toContain(String(rowsReturned));
      expect(truncation).toContain(String(rowsReturned + 3));
    });
  },
);
