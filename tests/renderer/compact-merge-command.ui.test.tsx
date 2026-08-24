// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CompactMergeCommand } from "../../src/renderer/src/components/compact-merge-command";
import { PatchdeskApiError } from "../../src/renderer/src/api-client";

afterEach(() => {
  cleanup();
});

describe("compact merge command", () => {
  it("does not describe a GitHub policy block as a conflict", () => {
    render(
      <CompactMergeCommand
        readiness={{
          _tag: "Blocked",
          blockers: ["merge_blocked"],
          warnings: [],
        }}
        context={{
          repo: "centraldigital/patchdesk",
          prNumber: 42,
          title: "Protect review writes",
          base: "sit",
          head: "feat/review",
          headSha: "abcdef1234567890",
        }}
        methods={["squash"]}
        onMerge={async () => ({})}
      />,
    );

    expect(screen.getByText("blocked by GitHub")).toBeTruthy();
    expect(screen.queryByText("conflicting changes")).toBeNull();
  });

  it("offers the safe GitHub action for partially evidenced blockers", async () => {
    const openExternalHttps = vi.fn(async () => true);
    Object.defineProperty(window, "patchdesk", {
      configurable: true,
      value: { openExternalHttps },
    });
    render(
      <CompactMergeCommand
        readiness={{
          _tag: "Blocked",
          blockers: ["merge_blocked"],
          warnings: [],
        }}
        mergeReasons={[
          {
            code: "blocked",
            message: "GitHub merge requirements are not satisfied.",
            source: "github_pr_state",
            availability: "partial",
            openOnGitHub: true,
          },
        ]}
        pullRequest={
          // SAFETY: This fixture uses valid PullRequestRef fields; branded IDs
          // are intentionally bypassed because this test does not exercise parsing.
          {
            host: "github.com",
            owner: "centraldigital",
            repo: "patchdesk",
            number: 42,
          } as never
        }
        context={{
          repo: "centraldigital/patchdesk",
          prNumber: 42,
          title: "Protect review writes",
          base: "sit",
          head: "feat/review",
          headSha: "abcdef1234567890",
        }}
        methods={["squash"]}
        onMerge={async () => ({})}
      />,
    );
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Open on GitHub" }));
    expect(openExternalHttps).toHaveBeenCalledWith(
      "https://github.com/centraldigital/patchdesk/pull/42",
    );
  });

  it("shows context and requires acknowledgement for merge warnings before one explicit merge", async () => {
    const user = userEvent.setup();
    const merge = vi.fn(async () => ({ mergeCommitSha: "abcdef" }));
    render(
      <CompactMergeCommand
        readiness={{
          _tag: "NeedsAcknowledgement",
          blockers: [],
          warnings: ["request_changes", "high_severity_finding"],
        }}
        context={{
          repo: "centraldigital/patchdesk",
          prNumber: 42,
          title: "Protect review writes",
          base: "sit",
          head: "feat/review",
          headSha: "abcdef1234567890",
        }}
        methods={["squash", "merge"]}
        onMerge={merge}
      />,
    );
    expect(
      screen.getByText(/request changes, high severity finding/),
    ).toBeTruthy();
    const mergeButton = screen.getByRole("button", { name: "Merge" });
    // SAFETY: The Merge role query returns the native button rendered by Button.
    expect((mergeButton as HTMLButtonElement).disabled).toBe(true);
    await user.click(screen.getByRole("checkbox", { name: /I acknowledge:/ }));
    await user.click(screen.getByRole("button", { name: "Merge" }));
    expect(merge).toHaveBeenCalledWith("squash", [
      "request_changes",
      "high_severity_finding",
    ]);
    expect(screen.getByText("Merged abcdef.")).toBeTruthy();
  });

  it("groups the catalogued merge methods without changing the choices", async () => {
    const user = userEvent.setup();
    render(
      <CompactMergeCommand
        readiness={{ _tag: "Ready", blockers: [], warnings: [] }}
        context={{
          repo: "centraldigital/patchdesk",
          prNumber: 42,
          title: "Protect review writes",
          base: "sit",
          head: "feat/review",
          headSha: "abcdef1234567890",
        }}
        methods={["squash", "merge"]}
        onMerge={async () => ({})}
      />,
    );

    await user.click(screen.getByRole("combobox", { name: "Merge method" }));

    expect(document.querySelector('[data-slot="select-group"]')).toBeTruthy();
    const choices = Array.from(
      document.querySelectorAll('[data-slot="select-item"]'),
      (item) => item.textContent,
    );
    expect(choices).toEqual(["squash", "merge"]);
    await user.keyboard("{Escape}");
  });

  it("keeps the merge choice and action in one named control group", () => {
    render(
      <CompactMergeCommand
        readiness={{ _tag: "Ready", blockers: [], warnings: [] }}
        context={{
          repo: "centraldigital/patchdesk",
          prNumber: 42,
          title: "Protect review writes",
          base: "sit",
          head: "feat/review",
          headSha: "abcdef1234567890",
        }}
        methods={["squash"]}
        onMerge={async () => ({})}
      />,
    );

    const mergeAction = screen.getByRole("group", { name: "Merge action" });
    expect(
      mergeAction.contains(
        screen.getByRole("combobox", { name: "Merge method" }),
      ),
    ).toBe(true);
    expect(
      mergeAction.contains(screen.getByRole("button", { name: "Merge" })),
    ).toBe(true);
  });

  it("explains that an in-progress action stopped the merge before GitHub received it", async () => {
    const user = userEvent.setup();
    render(
      <CompactMergeCommand
        readiness={{ _tag: "Ready", blockers: [], warnings: [] }}
        context={{
          repo: "centraldigital/patchdesk",
          prNumber: 42,
          title: "Protect review writes",
          base: "sit",
          head: "feat/review",
          headSha: "abcdef1234567890",
        }}
        methods={["squash"]}
        onMerge={async () => {
          throw new PatchdeskApiError(
            "merge_in_progress",
            409,
            false,
            "corr-merge-in-progress",
            "Another action is still finishing. The merge was not submitted. Wait a moment, then try again.",
          );
        }}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Merge" }));
    expect(
      await screen.findByText(
        "Another action is still finishing. The merge was not submitted. Wait a moment, then try again.",
      ),
    ).toBeTruthy();
  });

  it("reports a non-cancellable merge until GitHub returns a final result", async () => {
    let resolveMerge: ((value: { mergeCommitSha: string }) => void) | undefined;
    const user = userEvent.setup();
    render(
      <CompactMergeCommand
        readiness={{ _tag: "Ready", blockers: [], warnings: [] }}
        context={{
          repo: "centraldigital/patchdesk",
          prNumber: 42,
          title: "Protect review writes",
          base: "sit",
          head: "feat/review",
          headSha: "abcdef1234567890",
        }}
        methods={["squash"]}
        onMerge={async () =>
          await new Promise((resolve) => {
            resolveMerge = resolve;
          })
        }
      />,
    );
    await user.click(screen.getByRole("button", { name: "Merge" }));

    const mergingButton = screen.getByRole("button", { name: "Merging…" });
    // SAFETY: The Merging role query returns the native button rendered by Button.
    expect((mergingButton as HTMLButtonElement).disabled).toBe(true);
    resolveMerge?.({ mergeCommitSha: "abcdef" });
    expect(await screen.findByText("Merged abcdef.")).toBeTruthy();
  });
});

it("offers read-side recovery after a failed merge without issuing a second merge", async () => {
  const user = userEvent.setup();
  const merge = vi.fn(async () => {
    throw new Error("response lost");
  });
  const recover = vi.fn(async () => undefined);
  render(
    <CompactMergeCommand
      readiness={{ _tag: "Ready", blockers: [], warnings: [] }}
      context={{
        repo: "centraldigital/patchdesk",
        prNumber: 42,
        title: "Protect review writes",
        base: "sit",
        head: "feat/review",
        headSha: "abcdef1234567890",
      }}
      methods={["squash"]}
      onMerge={merge}
      onRecoverMerge={recover}
    />,
  );
  await user.click(screen.getByRole("button", { name: "Merge" }));
  const check = await screen.findByRole("button", {
    name: "Check GitHub status",
  });
  await user.click(check);
  expect(recover).toHaveBeenCalledTimes(1);
  expect(merge).toHaveBeenCalledTimes(1);
});
