// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PreparedReviewFlow, type PreparedReviewFlowWorkbench } from "../../src/renderer/src/flows/prepared-review-flow";

afterEach(cleanup);

const workbench: PreparedReviewFlowWorkbench = {
  state: "review_started",
  session: {
    id: "session-1",
    key: { profileId: "cfw", host: "github.com", owner: "centraldigital", repo: "patchdesk", prNumber: 42, headSha: "abcdef1234567890" },
  },
  recoveryView: { noticeKey: "ready_to_review", tone: "positive", actionKey: "run_review" },
};

const models = { models: [{ id: "model-1", label: "Model One" }], defaultModel: "model-1", defaultReasoning: "medium" };

type MockRequest = { readonly path: string; readonly method?: string; readonly body?: unknown };

function mockApi(handler: (request: MockRequest) => { readonly ok: boolean; readonly status: number; readonly body: unknown }) {
  Object.defineProperty(window, "patchdesk", {
    configurable: true,
    value: { request: vi.fn((request: MockRequest) => Promise.resolve({ correlationId: "test", ...handler(request) })) },
  });
}

const ok200 = (body: unknown) => ({ ok: true as const, status: 200, body });

async function startFromDialog() {
  fireEvent.click(await screen.findByRole("button", { name: "Run review" }));
  const confirm = await screen.findByRole("button", { name: "Start read-only review" });
  await waitFor(() => expect((confirm as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(confirm);
}

describe("prepared review run start", () => {
  it("shows a retryable walkthrough failure after generation is rejected", async () => {
    mockApi((request) => {
      if (request.path === "/v1/reviews/models") return ok200(models);
      if (request.path === "/v1/reviews/walkthrough/generate") {
        return {
          ok: false as const,
          status: 503,
          body: { error: "workflow_unavailable" },
        };
      }
      throw new Error(`unexpected ${request.path}`);
    });
    render(<PreparedReviewFlow workbench={workbench} onNavigate={() => {}} onWorkbenchPatch={() => {}} onWorkbenchReplace={() => {}} />);

    fireEvent.click(await screen.findByRole("button", { name: "Generate walkthrough" }));
    fireEvent.click(await screen.findByRole("button", { name: "Generate read-only walkthrough" }));

    expect(await screen.findByText("Walkthrough didn't finish")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry generation" })).toBeTruthy();
  });

  it("opens normal PR context without starting a model review", async () => {
    mockApi((request) => {
      if (request.path === "/v1/reviews/models") return ok200(models);
      throw new Error(`unexpected ${request.path}`);
    });
    render(<PreparedReviewFlow workbench={{
      ...workbench,
      pullRequest: { ref: { host: "github.com", owner: "centraldigital", repo: "patchdesk", number: 42 }, title: "Prepared PR", description: "Safe **description**", author: "reviewer", headBranch: "feat/prepared", baseBranch: "main", headSha: "abcdef1234567890", isDraft: false, isOpen: true, reviewState: "unknown", mergeability: "unknown", labels: [], updatedAt: "2026-07-16T00:00:00.000Z" } as never,
      checks: { overall: "passing", checks: [] },
      comments: { threads: [] },
      batch: { sessionId: "session-1", state: { _tag: "Local" }, summaryBody: "", suggestedEvent: "COMMENT", items: [], receipts: [], createdAt: "2026-07-16T00:00:00.000Z", updatedAt: "2026-07-16T00:00:00.000Z" } as never,
      freshness: "fresh",
    }} onNavigate={() => {}} onWorkbenchPatch={() => {}} onWorkbenchReplace={() => {}} />);

    fireEvent.click(await screen.findByRole("button", { name: "PR overview" }));
    expect(await screen.findByRole("heading", { name: "PR overview" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Collapse checks" })).toBeNull();
    expect(screen.getByText("Existing threads")).toBeTruthy();
    expect(screen.getByText("Your local review")).toBeTruthy();
    expect(document.querySelectorAll('[data-disclosure-motion="panel"]')).toHaveLength(2);
    expect(document.querySelectorAll('[data-disclosure-motion="chevron"]')).toHaveLength(4);
    expect(screen.queryByRole("dialog", { name: "Run local review" })).toBeNull();
  });

  it("refreshes GitHub checks for a prepared saved session", async () => {
    const replaced = vi.fn();
    mockApi((request) => {
      if (request.path === "/v1/reviews/models") return ok200(models);
      if (request.path === "/v1/reviews/refresh")
        return ok200({
          freshness: "fresh",
          refreshedAt: "2026-07-30T00:00:00.000Z",
          comments: { threads: [] },
          checks: {
            overall: "passing",
            checks: [
              {
                name: "check-test-coverage",
                required: "unknown",
                status: "completed",
                conclusion: "success",
              },
            ],
          },
          mergeReadiness: { _tag: "Ready", blockers: [], warnings: [] },
        });
      throw new Error(`unexpected ${request.path}`);
    });
    render(
      <PreparedReviewFlow
        workbench={{ ...workbench, freshness: "not_refreshed" }}
        onNavigate={() => {}}
        onWorkbenchPatch={() => {}}
        onWorkbenchReplace={replaced}
      />,
    );

    fireEvent.click(
      await screen.findByRole("button", { name: "Refresh GitHub state" }),
    );

    await waitFor(() =>
      expect(replaced).toHaveBeenCalledWith(
        expect.objectContaining({
          freshness: "fresh",
          checks: { overall: "passing", checks: expect.any(Array) },
        }),
      ),
    );
  });

  it("reopens the prepared session after refresh detects a changed head", async () => {
    const replaced = vi.fn();
    const requests: MockRequest[] = [];
    mockApi((request) => {
      requests.push(request);
      if (request.path === "/v1/reviews/models") return ok200(models);
      if (request.path === "/v1/reviews/refresh")
        return ok200({
          freshness: "stale",
          refreshedAt: "2026-07-30T00:00:00.000Z",
          comments: { threads: [] },
          checks: { overall: "passing", checks: [] },
        });
      if (request.path === "/v1/reviews/open")
        return ok200({
          state: "review_started",
          session: {
            id: "session-2",
            key: {
              profileId: "cfw",
              host: "github.com",
              owner: "centraldigital",
              repo: "patchdesk",
              prNumber: 42,
              headSha: "fedcba9876543210",
            },
          },
          recoveryView: {
            noticeKey: "ready_to_review",
            tone: "positive",
            actionKey: "run_review",
          },
        });
      throw new Error(`unexpected ${request.path}`);
    });
    render(
      <PreparedReviewFlow
        workbench={{ ...workbench, freshness: "fresh" }}
        onNavigate={() => {}}
        onWorkbenchPatch={() => {}}
        onWorkbenchReplace={replaced}
      />,
    );

    fireEvent.click(
      await screen.findByRole("button", { name: "Refresh GitHub state" }),
    );

    await waitFor(() =>
      expect(replaced).toHaveBeenCalledWith(
        expect.objectContaining({
          session: expect.objectContaining({ id: "session-2" }),
        }),
      ),
    );
    expect(requests.map((request) => request.path)).toContain("/v1/reviews/refresh");
    expect(requests.map((request) => request.path)).toContain("/v1/reviews/open");
    expect(requests.find((request) => request.path === "/v1/reviews/open")?.body).toMatchObject({ previousSessionId: "session-1" });
  });

  it("applies runId and attemptId so the workbench enters live progress", async () => {
    mockApi((request) => {
      if (request.path === "/v1/reviews/models") return ok200(models);
      if (request.path === "/v1/reviews/run") return ok200({ runId: "run-1", attemptId: "001", model: "model-1", reasoning: "medium" });
      throw new Error(`unexpected ${request.path}`);
    });
    const patched = vi.fn();
    render(<PreparedReviewFlow workbench={workbench} onNavigate={() => {}} onWorkbenchPatch={patched} onWorkbenchReplace={() => {}} />);

    await startFromDialog();

    await waitFor(() => expect(patched).toHaveBeenCalledWith({
      runId: "run-1",
    }));
  });

  it("shows an error and patches nothing when the start response lacks attemptId", async () => {
    mockApi((request) => {
      if (request.path === "/v1/reviews/models") return ok200(models);
      if (request.path === "/v1/reviews/run") return ok200({ runId: "run-1" });
      throw new Error(`unexpected ${request.path}`);
    });
    const patched = vi.fn();
    render(<PreparedReviewFlow workbench={workbench} onNavigate={() => {}} onWorkbenchPatch={patched} onWorkbenchReplace={() => {}} />);

    await startFromDialog();

    expect((await screen.findAllByText("Patchdesk stopped the last run before it completed. Try again when you're ready.")).length).toBeGreaterThan(0);
    expect(patched).not.toHaveBeenCalled();
  });

  it("shows the head-change message when the start is rejected with 409", async () => {
    mockApi((request) => {
      if (request.path === "/v1/reviews/models") return ok200(models);
      if (request.path === "/v1/reviews/run") return { ok: false as const, status: 409, body: { error: "head_changed" } };
      throw new Error(`unexpected ${request.path}`);
    });
    render(<PreparedReviewFlow workbench={workbench} onNavigate={() => {}} onWorkbenchPatch={() => {}} onWorkbenchReplace={() => {}} />);

    await startFromDialog();

    expect((await screen.findAllByText("Patchdesk stopped the last run before it completed. Try again when you're ready.")).length).toBeGreaterThan(0);
  });

  it("keeps Preparing non-actionable when recovery has no action key", async () => {
    mockApi((request) => {
      if (request.path === "/v1/reviews/models") return ok200(models);
      throw new Error(`unexpected ${request.path}`);
    });
    render(<PreparedReviewFlow workbench={{ ...workbench, recoveryView: { noticeKey: "preparing", tone: "neutral" } }} onNavigate={() => {}} onWorkbenchPatch={() => {}} onWorkbenchReplace={() => {}} />);

    expect((await screen.findAllByText("Preparing review")).length).toBe(1);
    expect((await screen.findAllByText("Patchdesk is preparing this pull request. You can wait or come back to this view later.")).length).toBe(1);
    expect(screen.queryByRole("button", { name: "Run review" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Start read-only review" })).toBeNull();
  });

  it("keeps an unavailable workbench non-actionable when recovery is omitted", async () => {
    mockApi((request) => {
      if (request.path === "/v1/reviews/models") return ok200(models);
      throw new Error(`unexpected ${request.path}`);
    });
    const unavailable: PreparedReviewFlowWorkbench = { state: workbench.state, session: workbench.session };
    render(<PreparedReviewFlow workbench={unavailable} onNavigate={() => {}} onWorkbenchPatch={() => {}} onWorkbenchReplace={() => {}} />);

    expect(await screen.findByText("Review unavailable")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Run review" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Start read-only review" })).toBeNull();
  });

  it("reconnects into live progress using the returned attempt id", async () => {
    mockApi((request) => {
      if (request.path === "/v1/reviews/models") return ok200(models);
      if (request.path === "/v1/runs/reconnect") return ok200({ runId: "run-owned", attemptId: "attempt-owned" });
      if (request.path === "/v1/runs/run-owned?sessionId=session-1&attemptId=attempt-owned") return ok200({ status: "running", elapsedMs: 1200, step: "inspecting" });
      throw new Error(`unexpected ${request.path}`);
    });
    const patched = vi.fn();
    render(<PreparedReviewFlow workbench={{ ...workbench, recoveryView: { noticeKey: "review_in_progress", tone: "positive", actionKey: "reconnect" } }} onNavigate={() => {}} onWorkbenchPatch={patched} onWorkbenchReplace={() => {}} />);

    fireEvent.click(await screen.findByRole("button", { name: "Reconnect" }));

    expect(await screen.findByText("Review in progress")).toBeTruthy();
    expect(patched).toHaveBeenCalledWith({ runId: "run-owned" });
  });

  it("prepares again through the open preparation path without starting a run", async () => {
    const requests: Array<string> = [];
    mockApi((request) => {
      requests.push(request.path);
      if (request.path === "/v1/reviews/models") return ok200(models);
      if (request.path === "/v1/reviews/open") return ok200({});
      throw new Error(`unexpected ${request.path}`);
    });
    render(<PreparedReviewFlow workbench={{ ...workbench, recoveryView: { noticeKey: "needs_preparation", tone: "warning", actionKey: "prepare_again" } }} onNavigate={() => {}} onWorkbenchPatch={() => {}} onWorkbenchReplace={() => {}} />);

    const prepareButton = await screen.findByRole("button", { name: "Prepare again" });
    expect(prepareButton.getAttribute("data-variant")).toBe("outline");
    expect(prepareButton.className).toContain("border-amber");
    fireEvent.click(prepareButton);

    await waitFor(() => expect(requests).toContain("/v1/reviews/open"));
    expect(requests).not.toContain("/v1/reviews/run");
  });
});

it("shows the previous run failure above the ready card", async () => {
    mockApi((request) => {
      if (request.path === "/v1/reviews/models") return ok200(models);
      throw new Error(`unexpected ${request.path}`);
    });
    const failedWorkbench: PreparedReviewFlowWorkbench = {
      ...workbench,
      recoveryView: { noticeKey: "review_failed", tone: "warning", actionKey: "try_again" },
    };
    render(<PreparedReviewFlow workbench={failedWorkbench} onNavigate={() => {}} onWorkbenchPatch={() => {}} onWorkbenchReplace={() => {}} />);

    expect(await screen.findByText("Review couldn't finish")).toBeTruthy();
    expect(screen.getAllByText(/Patchdesk stopped the last run before it completed/).length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  describe("run dialog starting state", () => {
  it("keeps the dialog open with a busy confirm button while the start is in flight", async () => {
    mockApi((request) => {
      if (request.path === "/v1/reviews/models") return ok200(models);
      if (request.path === "/v1/reviews/run") {
        return { ok: true as const, status: 200, body: new Promise(() => {}) };
      }
      throw new Error(`unexpected ${request.path}`);
    });
    render(<PreparedReviewFlow workbench={workbench} onNavigate={() => {}} onWorkbenchPatch={() => {}} onWorkbenchReplace={() => {}} />);

    fireEvent.click(await screen.findByRole("button", { name: "Run review" }));
    const confirm = await screen.findByRole("button", { name: "Start read-only review" });
    await waitFor(() => expect((confirm as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(confirm);

    const busy = await screen.findByRole("button", { name: "Starting…" });
    expect((busy as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole("button", { name: "Start read-only review" })).toBeNull();
  });

  it("shows start errors inside the dialog when opened from the checks section", async () => {
    mockApi((request) => {
      if (request.path === "/v1/reviews/models") return ok200(models);
      if (request.path === "/v1/reviews/run") return { ok: false as const, status: 503, body: { error: "storage" } };
      throw new Error(`unexpected ${request.path}`);
    });
    render(<PreparedReviewFlow workbench={workbench} initialSection="checks" onNavigate={() => {}} onWorkbenchPatch={() => {}} onWorkbenchReplace={() => {}} />);

    fireEvent.click(await screen.findByRole("button", { name: "Run review" }));
    const confirm = await screen.findByRole("button", { name: "Start read-only review" });
    await waitFor(() => expect((confirm as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(confirm);

    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(dialog.textContent).toContain("Patchdesk stopped the last run before it completed. Try again when you're ready."));
  });
});
