// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ReviewerPicker } from "../../src/renderer/src/components/reviewer-picker";
import { PatchdeskApiError } from "../../src/renderer/src/api-client";
import type { ReviewerListResponse } from "../../src/renderer/src/renderer-contracts";

afterEach(() => cleanup());

const reviewerCandidates: ReviewerListResponse = {
  state: "ready",
  suggested: [
    { isAuthor: true, isCommenter: false, reviewer: { login: "octocat" } },
  ],
  candidates: [
    { id: "U_bug", login: "octocat" },
    { id: "U_docs", login: "hubot" },
  ],
  candidatesTotalCount: 2,
  permission: "permitted",
};

function actionsFixture(
  overrides: Partial<{
    fetchReviewers: (
      query?: string,
    ) => Promise<ReviewerListResponse | undefined>;
    requestReviewers: (
      reviewers: ReadonlyArray<{
        readonly id: string;
        readonly login: string;
      }>,
    ) => Promise<void>;
    removeReviewers: (
      reviewers: ReadonlyArray<{
        readonly id: string;
        readonly login: string;
      }>,
    ) => Promise<void>;
  }> = {},
) {
  return {
    fetchReviewers: vi.fn(async () => reviewerCandidates),
    requestReviewers: vi.fn(async () => undefined),
    removeReviewers: vi.fn(async () => undefined),
    ...overrides,
  };
}

async function openPicker(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Manage reviewers" }));
}

describe("ReviewerPicker", () => {
  it("renders nothing when the Review can no longer accept reviewer writes", () => {
    const { container } = render(<ReviewerPicker attachedReviewers={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it("states no reviewer number, unlike the assignee picker's ten-person cap", async () => {
    const user = userEvent.setup();
    render(
      <ReviewerPicker attachedReviewers={[]} actions={actionsFixture()} />,
    );
    await openPicker(user);
    await screen.findByRole("checkbox", { name: "hubot" });
    expect(screen.queryByText(/up to \d+ reviewer/i)).toBeNull();
  });

  it("groups the suggested reviewer above the remaining candidates, with honest caption copy", async () => {
    const user = userEvent.setup();
    render(
      <ReviewerPicker attachedReviewers={[]} actions={actionsFixture()} />,
    );
    await openPicker(user);
    const suggestedGroup = await screen.findByRole("group", {
      name: "Suggested reviewers",
    });
    expect(suggestedGroup.textContent?.includes("octocat")).toBeTruthy();
    expect(
      suggestedGroup.textContent?.includes("Authored this change"),
    ).toBeTruthy();
    // hubot is not suggested, so it renders outside the suggested group.
    expect(suggestedGroup.textContent?.includes("hubot")).toBeFalsy();
    const candidateGroup = screen.getByRole("list", {
      name: "Reviewer candidates",
    });
    expect(candidateGroup.textContent?.includes("hubot")).toBeTruthy();
  });

  it("renders currently requested reviewers as checked and other candidates as available", async () => {
    const user = userEvent.setup();
    const actions = actionsFixture();
    render(
      <ReviewerPicker attachedReviewers={["octocat"]} actions={actions} />,
    );
    await openPicker(user);
    await waitFor(() => expect(actions.fetchReviewers).toHaveBeenCalledOnce());
    const octocatCheckbox = await screen.findByRole("checkbox", {
      name: "octocat",
    });
    const hubotCheckbox = screen.getByRole("checkbox", { name: "hubot" });
    expect(octocatCheckbox.getAttribute("aria-checked")).toBe("true");
    expect(hubotCheckbox.getAttribute("aria-checked")).toBe("false");
  });

  it("issues a request-reviewers command with the toggled person's id and login", async () => {
    const user = userEvent.setup();
    const actions = actionsFixture();
    render(<ReviewerPicker attachedReviewers={[]} actions={actions} />);
    await openPicker(user);
    const hubotCheckbox = await screen.findByRole("checkbox", {
      name: "hubot",
    });
    await user.click(hubotCheckbox);
    await waitFor(() =>
      expect(actions.requestReviewers).toHaveBeenCalledWith([
        { id: "U_docs", login: "hubot" },
      ]),
    );
    expect(actions.removeReviewers).not.toHaveBeenCalled();
  });

  it("issues a remove-reviewers command with the toggled person's id and login", async () => {
    const user = userEvent.setup();
    const actions = actionsFixture();
    render(
      <ReviewerPicker attachedReviewers={["octocat"]} actions={actions} />,
    );
    await openPicker(user);
    const octocatCheckbox = await screen.findByRole("checkbox", {
      name: "octocat",
    });
    await user.click(octocatCheckbox);
    await waitFor(() =>
      expect(actions.removeReviewers).toHaveBeenCalledWith([
        { id: "U_bug", login: "octocat" },
      ]),
    );
    expect(actions.requestReviewers).not.toHaveBeenCalled();
  });

  it("shows the toggled person immediately (optimistic) and reconciles once the authoritative requested reviewers arrive", async () => {
    const user = userEvent.setup();
    const actions = actionsFixture();
    const { rerender } = render(
      <ReviewerPicker attachedReviewers={[]} actions={actions} />,
    );
    await openPicker(user);
    const hubotCheckbox = await screen.findByRole("checkbox", {
      name: "hubot",
    });
    await user.click(hubotCheckbox);
    expect(
      screen
        .getByRole("checkbox", { name: "hubot" })
        .getAttribute("aria-checked"),
    ).toBe("true");
    await waitFor(() =>
      expect(actions.requestReviewers).toHaveBeenCalledOnce(),
    );
    rerender(
      <ReviewerPicker attachedReviewers={["hubot"]} actions={actions} />,
    );
    expect(
      screen
        .getByRole("checkbox", { name: "hubot" })
        .getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("reverts a failed request and names the person instead of silently reverting", async () => {
    const user = userEvent.setup();
    const actions = actionsFixture({
      requestReviewers: vi.fn(async () => {
        throw new Error("network down");
      }),
    });
    render(<ReviewerPicker attachedReviewers={[]} actions={actions} />);
    await openPicker(user);
    const hubotCheckbox = await screen.findByRole("checkbox", {
      name: "hubot",
    });
    await user.click(hubotCheckbox);
    await waitFor(() =>
      expect(
        screen
          .getByRole("checkbox", { name: "hubot" })
          .getAttribute("aria-checked"),
      ).toBe("false"),
    );
    expect(
      await screen.findByText('Patchdesk could not ask "hubot" to review.'),
    ).toBeTruthy();
  });

  it("reverts a failed removal and names the person, with the specific reason from the API error", async () => {
    const user = userEvent.setup();
    const actions = actionsFixture({
      removeReviewers: vi.fn(async () => {
        throw new PatchdeskApiError(
          "unavailable",
          503,
          true,
          "corr-remove",
          "Patchdesk could not reach GitHub.",
        );
      }),
    });
    render(
      <ReviewerPicker attachedReviewers={["octocat"]} actions={actions} />,
    );
    await openPicker(user);
    const octocatCheckbox = await screen.findByRole("checkbox", {
      name: "octocat",
    });
    await user.click(octocatCheckbox);
    expect(
      await screen.findByText(
        'Patchdesk could not remove "octocat" from the requested reviewers. Patchdesk could not reach GitHub.',
      ),
    ).toBeTruthy();
  });

  it("fully enables the picker with no caveat when the service reports 'permitted'", async () => {
    const user = userEvent.setup();
    render(
      <ReviewerPicker attachedReviewers={[]} actions={actionsFixture()} />,
    );
    await openPicker(user);
    const octocatCheckbox = await screen.findByRole("checkbox", {
      name: "octocat",
    });
    expect(octocatCheckbox.getAttribute("aria-disabled")).not.toBe("true");
    expect(
      screen.queryByText(
        "This account cannot manage reviewers on this repository.",
      ),
    ).toBeNull();
    expect(
      screen.queryByText(
        "Patchdesk could not confirm you can manage reviewers here — a change may be refused.",
      ),
    ).toBeNull();
  });

  it("shows the honest unconfirmed caveat, without hiding or disabling the picker, when permission evidence is unavailable", async () => {
    const user = userEvent.setup();
    const actions = actionsFixture({
      fetchReviewers: vi.fn(async () => ({
        ...reviewerCandidates,
        permission: "unknown" as const,
      })),
    });
    render(<ReviewerPicker attachedReviewers={[]} actions={actions} />);
    await openPicker(user);
    expect(
      await screen.findByText(
        "Patchdesk could not confirm you can manage reviewers here — a change may be refused.",
      ),
    ).toBeTruthy();
    const octocatCheckbox = screen.getByRole("checkbox", { name: "octocat" });
    expect(octocatCheckbox.getAttribute("aria-disabled")).not.toBe("true");
  });

  it("disables the picker and states the account cannot manage reviewers, with no retry, when the service reports 'denied'", async () => {
    const user = userEvent.setup();
    const requestReviewers = vi.fn(async () => undefined);
    const actions = actionsFixture({
      fetchReviewers: vi.fn(async () => ({
        ...reviewerCandidates,
        permission: "denied" as const,
      })),
      requestReviewers,
    });
    render(<ReviewerPicker attachedReviewers={[]} actions={actions} />);
    await openPicker(user);
    expect(
      await screen.findByText(
        "This account cannot manage reviewers on this repository.",
      ),
    ).toBeTruthy();
    const hubotCheckbox = screen.getByRole("checkbox", { name: "hubot" });
    expect(hubotCheckbox.getAttribute("aria-disabled")).toBe("true");
    await user.click(hubotCheckbox);
    expect(requestReviewers).not.toHaveBeenCalled();
  });

  it("shows a forbidden read's specific reason instead of an empty list", async () => {
    const user = userEvent.setup();
    const actions = actionsFixture({
      fetchReviewers: vi.fn(async () => ({
        state: "github_forbidden" as const,
        forbiddenReason: "saml" as const,
      })),
    });
    render(<ReviewerPicker attachedReviewers={[]} actions={actions} />);
    await openPicker(user);
    expect(
      await screen.findByText(
        "GitHub blocked this read: this account's token needs SAML single sign-on authorization.",
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("checkbox")).toBeNull();
  });

  it("reads a failed fetch as a failure, not an empty list", async () => {
    const user = userEvent.setup();
    const actions = actionsFixture({
      fetchReviewers: vi.fn(async () => {
        throw new Error("network down");
      }),
    });
    render(<ReviewerPicker attachedReviewers={[]} actions={actions} />);
    await openPicker(user);
    expect(
      await screen.findByText(
        "Patchdesk could not load this repository's reviewer candidates. Reopen this menu to retry.",
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("checkbox")).toBeNull();
  });

  it("makes truncation visible when candidatesTotalCount exceeds the returned candidates", async () => {
    const user = userEvent.setup();
    const actions = actionsFixture({
      fetchReviewers: vi.fn(async () => ({
        state: "ready" as const,
        suggested: [],
        candidates: [{ id: "U_bug", login: "octocat" }],
        candidatesTotalCount: 150,
      })),
    });
    render(<ReviewerPicker attachedReviewers={[]} actions={actions} />);
    await openPicker(user);
    expect(
      await screen.findByText(
        "Showing 1 of 150 candidates. Some repository collaborators aren't shown.",
      ),
    ).toBeTruthy();
  });

  it("sends the search box's value to fetchReviewers, debounced, once typing settles", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({
      advanceTimers: (ms) => vi.advanceTimersByTime(ms),
    });
    const actions = actionsFixture();
    render(<ReviewerPicker attachedReviewers={[]} actions={actions} />);
    await openPicker(user);
    await waitFor(() =>
      expect(actions.fetchReviewers).toHaveBeenCalledWith(undefined),
    );
    const search = screen.getByRole("searchbox", {
      name: "Search reviewer candidates",
    });
    await user.type(search, "hub");
    // Not yet, before the debounce window elapses.
    expect(actions.fetchReviewers).not.toHaveBeenCalledWith("hub");
    await vi.advanceTimersByTimeAsync(250);
    await waitFor(() =>
      expect(actions.fetchReviewers).toHaveBeenCalledWith("hub"),
    );
    vi.useRealTimers();
  });

  it("never lets a slow, stale response overwrite a newer one", async () => {
    let resolveFirst: (value: ReviewerListResponse | undefined) => void = () =>
      undefined;
    const first = new Promise<ReviewerListResponse | undefined>((resolve) => {
      resolveFirst = resolve;
    });
    const fetchReviewers = vi
      .fn<(query?: string) => Promise<ReviewerListResponse | undefined>>()
      .mockImplementationOnce(() => first)
      .mockImplementationOnce(async () => ({
        state: "ready",
        suggested: [],
        candidates: [{ id: "U_docs", login: "hubot" }],
        candidatesTotalCount: 1,
        permission: "permitted",
      }));
    const actions = actionsFixture({ fetchReviewers });
    render(<ReviewerPicker attachedReviewers={[]} actions={actions} />);
    const user = userEvent.setup();
    await openPicker(user);
    await waitFor(() => expect(fetchReviewers).toHaveBeenCalledTimes(1));
    // Force a second request while the first is still pending, by closing
    // and reopening the picker.
    await user.click(screen.getByRole("button", { name: "Manage reviewers" }));
    await user.click(screen.getByRole("button", { name: "Manage reviewers" }));
    await waitFor(() => expect(fetchReviewers).toHaveBeenCalledTimes(2));
    await screen.findByRole("checkbox", { name: "hubot" });
    // The stale first response lands after the second already rendered.
    resolveFirst({
      state: "ready",
      suggested: [],
      candidates: [{ id: "U_bug", login: "octocat" }],
      candidatesTotalCount: 1,
      permission: "permitted",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByRole("checkbox", { name: "octocat" })).toBeNull();
    expect(screen.getByRole("checkbox", { name: "hubot" })).toBeTruthy();
  });
});
