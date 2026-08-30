// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CompactMergeCommand } from "../../src/renderer/src/components/compact-merge-command";
import { PatchdeskApiError } from "../../src/renderer/src/api-client";
import { deriveCheckReasons } from "../../src/domain/merge-readiness";
import { installDesktopDouble } from "./fake-desktop-response";

let desktop: ReturnType<typeof installDesktopDouble> | undefined;

afterEach(() => {
  cleanup();
  desktop?.restore();
  desktop = undefined;
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
        onMerge={async () => ({ state: "confirmed" })}
      />,
    );

    expect(screen.getByText("blocked by GitHub")).toBeTruthy();
    expect(screen.queryByText("conflicting changes")).toBeNull();
  });

  it("offers the safe GitHub action for partially evidenced blockers", async () => {
    const openExternalHttps = vi.fn(async () => true);
    desktop = installDesktopDouble({}, { openExternalHttps });
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
        onMerge={async () => ({ state: "confirmed" })}
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
    const merge = vi.fn(async () => ({
      state: "confirmed" as const,
      mergeCommitSha: "abcdef",
    }));
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
        onMerge={async () => ({ state: "confirmed" })}
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
        onMerge={async () => ({ state: "confirmed" })}
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
    let resolveMerge:
      | ((value: {
          readonly state: "confirmed";
          readonly mergeCommitSha: string;
        }) => void)
      | undefined;
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
          await new Promise<{
            readonly state: "confirmed";
            readonly mergeCommitSha: string;
          }>((resolve) => {
            resolveMerge = resolve;
          })
        }
      />,
    );
    await user.click(screen.getByRole("button", { name: "Merge" }));

    const mergingButton = screen.getByRole("button", { name: "Merging…" });
    // SAFETY: The Merging role query returns the native button rendered by Button.
    expect((mergingButton as HTMLButtonElement).disabled).toBe(true);
    resolveMerge?.({ state: "confirmed", mergeCommitSha: "abcdef" });
    expect(await screen.findByText("Merged abcdef.")).toBeTruthy();
  });

  it("keeps a failed and an unfinished required check as two separately identified rows", () => {
    const reasons = deriveCheckReasons({
      overall: "failing",
      checks: [
        {
          name: "build",
          required: true,
          status: "completed",
          conclusion: "failure",
        },
        { name: "lint", required: true, status: "in_progress" },
      ],
    });
    // Both reasons carry `code: "checks"`, so a key taken from the code alone
    // gives two list rows the same React identity.
    expect(reasons).toHaveLength(2);
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    try {
      render(
        <CompactMergeCommand
          readiness={{
            _tag: "Blocked",
            blockers: ["required_check"],
            warnings: [],
          }}
          mergeReasons={reasons}
          context={{
            repo: "centraldigital/patchdesk",
            prNumber: 42,
            title: "Protect review writes",
            base: "sit",
            head: "feat/review",
            headSha: "abcdef1234567890",
          }}
          methods={["squash"]}
          onMerge={async () => ({ state: "confirmed" })}
        />,
      );

      expect(
        screen.getByText("Required check build did not pass."),
      ).toBeTruthy();
      expect(
        screen.getByText("Required check lint has not finished."),
      ).toBeTruthy();
      expect(
        consoleError.mock.calls
          .map((call) => call.map((argument) => String(argument)).join(" "))
          .join("\n"),
      ).not.toContain("same key");
    } finally {
      consoleError.mockRestore();
    }
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

it("preserves confirmed terminal merge UI when refresh is required", async () => {
  const user = userEvent.setup();
  const merge = vi.fn(async () => ({
    state: "confirmed_refresh_required" as const,
    mergeCommitSha: "c".repeat(40),
  }));
  const recover = vi.fn(async () => undefined);
  render(
    <CompactMergeCommand
      readiness={{
        _tag: "NeedsAcknowledgement",
        blockers: [],
        warnings: ["request_changes"],
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
      onMerge={merge}
      onRecoverMerge={recover}
    />,
  );

  await user.click(screen.getByRole("checkbox", { name: /I acknowledge:/ }));
  await user.click(screen.getByRole("button", { name: "Merge" }));

  expect(await screen.findByRole("status", { name: /Merged/ })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Merge" })).toBeNull();
  await user.click(screen.getByRole("button", { name: "Check GitHub status" }));
  expect(recover).toHaveBeenCalledTimes(1);
  expect(merge).toHaveBeenCalledTimes(1);
});

it("guards submit and check in the same tick while showing pending spinners", async () => {
  let resolveMerge:
    | ((value: { readonly state: "confirmed_refresh_required" }) => void)
    | undefined;
  let resolveCheck: (() => void) | undefined;
  const merge = vi.fn(
    async () =>
      await new Promise<{ readonly state: "confirmed_refresh_required" }>(
        (resolve) => {
          resolveMerge = resolve;
        },
      ),
  );
  const recover = vi.fn(
    async () =>
      await new Promise<void>((resolve) => {
        resolveCheck = resolve;
      }),
  );
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

  const submit = screen.getByRole("button", { name: "Merge" });
  fireEvent.click(submit);
  fireEvent.click(submit);
  expect(merge).toHaveBeenCalledTimes(1);
  // SAFETY: the role query returns the native button rendered by Button.
  expect(
    (screen.getByRole("button", { name: "Merging…" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  resolveMerge?.({ state: "confirmed_refresh_required" });
  expect(await screen.findByRole("status", { name: /Merged/ })).toBeTruthy();

  const check = screen.getByRole("button", { name: "Check GitHub status" });
  fireEvent.click(check);
  fireEvent.click(check);
  expect(recover).toHaveBeenCalledTimes(1);
  // SAFETY: the role query returns the native button rendered by Button.
  expect(
    (screen.getByRole("button", { name: "Checking…" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  resolveCheck?.();
});
