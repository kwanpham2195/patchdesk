// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ReviewerPicker } from "../../src/renderer/src/components/reviewer-picker";
import type { ReviewerListResponse } from "../../src/renderer/src/renderer-contracts";

/**
 * What only a mounted `ReviewerPicker` can show, and only this one: GitHub's
 * suggestions render as their own group above the rest, matched to the
 * candidate that carries the node id the write needs, each captioned from
 * that suggestion's own `isAuthor`/`isCommenter` flags; no reviewer ceiling
 * is ever stated (unlike the assignee picker's ten); each row draws the
 * avatar the response carried; and a toggle leaves in this surface's
 * `[{id, login}]` shape.
 *
 * The state machine is proved once in `use-github-item-picker.test.ts`; the
 * rendering contract shared with the other two pickers is proved once per
 * picker in `github-item-picker.rendering.test.tsx`.
 */

afterEach(() => cleanup());

// A tiny, obviously-fake `data:` URI, enough for `Avatar` to take its
// `<img>` branch instead of the initials-badge one.
const FIXTURE_AVATAR_DATA_URI = "data:image/png;base64,AAAA";

const reviewerCandidates: ReviewerListResponse = {
  state: "ready",
  // Neither suggestion is the first candidate, so a picker that stopped
  // matching a suggestion to its candidate by login would show the wrong
  // person here.
  suggested: [
    { isAuthor: true, isCommenter: false, reviewer: { login: "hubot" } },
    { isAuthor: false, isCommenter: true, reviewer: { login: "monalisa" } },
  ],
  candidates: [
    { id: "U_bug", login: "octocat", avatarDataUri: FIXTURE_AVATAR_DATA_URI },
    { id: "U_docs", login: "hubot" },
    { id: "U_cat", login: "monalisa" },
  ],
  candidatesTotalCount: 3,
  permission: "permitted",
};

type FetchList = () => Promise<ReviewerListResponse | undefined>;

function actionsFixture(
  fetchReviewers: FetchList = async () => reviewerCandidates,
) {
  return {
    fetchReviewers: vi.fn(fetchReviewers),
    requestReviewers: vi.fn(async () => undefined),
    removeReviewers: vi.fn(async () => undefined),
  };
}

/** The row for one candidate, by the label its checkbox carries. */
const checkbox = (name: string): HTMLElement =>
  screen.getByRole("checkbox", { name });

async function openPicker(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Manage reviewers" }));
}

describe("ReviewerPicker", () => {
  it("renders nothing when the Review can no longer accept reviewer writes", () => {
    const { container } = render(<ReviewerPicker attachedReviewers={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it("groups GitHub's suggestions above the remaining candidates, captions each from its own flags, and states no reviewer ceiling", async () => {
    const user = userEvent.setup();
    const actions = actionsFixture();
    render(
      <ReviewerPicker attachedReviewers={["octocat"]} actions={actions} />,
    );
    await openPicker(user);
    const suggested = await screen.findByRole("group", {
      name: "Suggested reviewers",
    });
    const rest = screen.getByRole("list", { name: "Reviewer candidates" });
    expect(suggested.textContent).toContain("hubot");
    expect(suggested.textContent).toContain("monalisa");
    // octocat was not suggested, so it renders only below the group.
    expect(suggested.textContent).not.toContain("octocat");
    expect(rest.textContent).toContain("octocat");
    expect(rest.textContent).not.toContain("hubot");
    // An author and a commenter are two different reasons, and neither is
    // GitHub's own words — the picker derives both from the flags.
    const captions = [
      ...suggested.querySelectorAll(
        '[data-slot="reviewer-suggestion-caption"]',
      ),
    ].map((caption) => caption.textContent);
    expect(new Set(captions).size).toBe(2);
    // GitHub's reviewer cap could not be verified, so none is invented.
    expect(document.querySelector('[data-slot="picker-cap"]')).toBeNull();
    expect(checkbox("octocat").getAttribute("aria-checked")).toBe("true");
    expect(document.querySelectorAll('img[data-slot="avatar"]')).toHaveLength(
      1,
    );
  });

  it("sends each toggled row to the reviewer command for its own direction, in this surface's own shape, and the search box to its own fetch", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({
      advanceTimers: (ms) => vi.advanceTimersByTime(ms),
    });
    const actions = actionsFixture();
    render(
      <ReviewerPicker attachedReviewers={["octocat"]} actions={actions} />,
    );
    await openPicker(user);
    await user.click(await screen.findByRole("checkbox", { name: "hubot" }));
    await waitFor(() =>
      expect(actions.requestReviewers).toHaveBeenCalledWith([
        { id: "U_docs", login: "hubot" },
      ]),
    );
    expect(actions.removeReviewers).not.toHaveBeenCalled();
    await user.click(checkbox("octocat"));
    await waitFor(() =>
      expect(actions.removeReviewers).toHaveBeenCalledWith([
        { id: "U_bug", login: "octocat" },
      ]),
    );
    expect(actions.requestReviewers).toHaveBeenCalledOnce();
    await user.type(
      screen.getByRole("searchbox", { name: "Search reviewer candidates" }),
      "hub",
    );
    await vi.advanceTimersByTimeAsync(250);
    await waitFor(() =>
      expect(actions.fetchReviewers).toHaveBeenCalledWith("hub"),
    );
    vi.useRealTimers();
  });

  it("shows a denied permission on the rows themselves, not only in the hook", async () => {
    const user = userEvent.setup();
    const actions = actionsFixture(async () => ({
      ...reviewerCandidates,
      permission: "denied" as const,
    }));
    render(<ReviewerPicker attachedReviewers={[]} actions={actions} />);
    await openPicker(user);
    await screen.findByRole("checkbox", { name: "hubot" });
    expect(
      document.querySelector('[data-slot="picker-permission-denied"]'),
    ).toBeTruthy();
    expect(checkbox("hubot").getAttribute("aria-disabled")).toBe("true");
  });
});
