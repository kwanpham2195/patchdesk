// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CompletedReviewFlow, type CompletedReviewFlowWorkbench } from "../../src/renderer/src/flows/completed-review-flow";

afterEach(cleanup);

const workbench: CompletedReviewFlowWorkbench = {
  state: "completed",
  session: {
    id: "github.com__centraldigital__patchdesk__pr-42__sha-22222222__abcdef123456",
    key: { profileId: "cfw" },
  },
  result: { findings: [], summary: "ok", verdict: "approve", assumptions: [], validationPlan: [] },
  comments: { threads: [] },
  checks: { overall: "passing", checks: [] },
  mergeReadiness: { _tag: "Ready", blockers: [], warnings: [] },
  reviewScope: { kind: "full" },
  comparisonAvailability: "not_requested",
  reviewedHeadSha: "2222222222222222222222222222222222222222",
  refreshedAt: "2026-07-18T00:00:00.000Z",
  freshness: "fresh",
};

const models = {
  models: [{ id: "model-1", label: "Model One" }],
  defaultModel: "model-1",
  defaultReasoning: "medium",
  reasoning: ["low", "medium", "high"],
};

const projection: { readonly ready: unknown } = {
  ready: {
    lifecycle: "ready",
    noticeKey: "walkthrough-ready",
    walkthrough: {
      snapshot: {
        profileId: "cfw",
        sessionId: workbench.session.id,
        headSha: workbench.reviewedHeadSha,
        patchHash: "0000000000000000000000000000000000000000",
      },
      title: "Read-only walkthrough",
      focus: "What this change means for reviewers",
      chapters: [],
      support: { id: "support", title: "Support", hunkIds: [], hunks: [] },
    },
  },
};

type MockRequest = { readonly path: string; readonly method?: string; readonly body?: unknown };

function mockApi(
  handler: (
    request: MockRequest,
  ) =>
    | { readonly ok: boolean; readonly status: number; readonly body: unknown }
    | Promise<{ readonly ok: boolean; readonly status: number; readonly body: unknown }>,
) {
  Object.defineProperty(window, "patchdesk", {
    configurable: true,
    value: {
      request: vi.fn((request: MockRequest) =>
        Promise.resolve(handler(request)).then((response) => ({ correlationId: "test", ...response })),
      ),
    },
  });
}

const ok200 = (body: unknown) => ({ ok: true as const, status: 200, body });

function refreshedProjection(sessionId: string, headSha: string) {
  return {
    state: "review",
    review: { id: "review-2", status: "open" },
    session: { id: sessionId, key: { profileId: "cfw", host: "github.com", owner: "centraldigital", repo: "patchdesk", prNumber: 42, headSha } },
    revision: { reviewedHeadSha: headSha, currentHeadSha: headSha, freshness: "fresh", refreshedAt: "2026-07-30T00:00:00.000Z" },
    commits: [],
    insights: { analysis: { status: "not_generated" }, walkthrough: { status: "not_generated" } },
    publishedFeedback: { reviews: [], comments: [] },
    comments: { threads: [] },
    checks: { overall: "passing", checks: [] },
    mergeReadiness: { _tag: "Ready", blockers: [], warnings: [] },
  };
}

describe("completed review walkthrough generation", () => {
  it("atomically replaces the workbench when refresh finds a changed head", async () => {
    const replaced = vi.fn();
    const requests: MockRequest[] = [];
    mockApi((request) => {
      requests.push(request);
      if (request.path === "/v1/reviews/models") return ok200(models);
      if (request.path === "/v1/reviews/refresh")
        return ok200(refreshedProjection("session-current", "3333333333333333"));
      throw new Error(`unexpected ${request.path}`);
    });
    render(
      <CompletedReviewFlow
        workbench={{
          ...workbench,
          session: {
            ...workbench.session,
            key: {
              profileId: "cfw",
              host: "github.com",
              owner: "centraldigital",
              repo: "patchdesk",
              prNumber: 42,
            },
          },
        }}
        onWorkbenchPatch={() => {}}
        onWorkbenchReplace={replaced}
        onNavigationStateChange={() => {}}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Refresh" }));

    await waitFor(() =>
      expect(replaced).toHaveBeenCalledWith(
        expect.objectContaining({
          state: "review",
          session: expect.objectContaining({ id: "session-current" }),
        }),
      ),
    );
    expect(requests.map((request) => request.path)).not.toContain("/v1/reviews/open");
    expect(requests.find((request) => request.path === "/v1/reviews/refresh")?.body).toMatchObject({
      profileId: "cfw",
      reviewId: expect.any(String),
    });
  });

  it("does not request walkthrough generation on workbench open", async () => {
    const requests: Array<string> = [];
    mockApi((request) => {
      requests.push(request.path);
      if (request.path === "/v1/reviews/models") return ok200(models);
      throw new Error(`unexpected ${request.path}`);
    });
    render(<CompletedReviewFlow workbench={workbench} onWorkbenchPatch={() => {}} onNavigationStateChange={() => {}} />);

    await waitFor(() => expect(screen.getByRole("button", { name: "Generate walkthrough" })).toBeTruthy());
    expect(requests).not.toContain("/v1/reviews/walkthrough/generate");
    expect(requests).not.toContain("/v1/reviews/walkthrough/load");
  });

  it("opens the dialog with the accepted copy and calls the API only after confirmation", async () => {
    const requests: Array<{ path: string; body: unknown }> = [];
    mockApi((request) => {
      requests.push({ path: request.path, body: request.body });
      if (request.path === "/v1/reviews/models") return ok200(models);
      if (request.path === "/v1/reviews/walkthrough/generate") return ok200(projection.ready);
      throw new Error(`unexpected ${request.path}`);
    });
    render(<CompletedReviewFlow workbench={workbench} onWorkbenchPatch={() => {}} onNavigationStateChange={() => {}} />);

    fireEvent.click(await screen.findByRole("button", { name: "Generate walkthrough" }));

    await waitFor(() => expect(screen.getByTestId("walkthrough-generate-dialog")).toBeTruthy());
    expect(screen.getAllByText("Patchdesk reads the stored patch, never writes to GitHub, and never restarts the run.").length).toBeGreaterThan(0);

    const confirm = screen.getByRole("button", { name: "Generate read-only walkthrough" });
    fireEvent.click(confirm);

    await waitFor(() => expect(requests.find((request) => request.path === "/v1/reviews/walkthrough/generate")).toBeDefined());
    const generate = requests.find((request) => request.path === "/v1/reviews/walkthrough/generate");
    expect(generate?.body).toMatchObject({ profileId: "cfw", sessionId: workbench.session.id, model: "model-1", reasoning: "medium" });
  });

  it("disables the confirm action when the catalog is unavailable", async () => {
    mockApi((request) => {
      if (request.path === "/v1/reviews/models") return { ok: false, status: 503, body: { error: "catalog_unavailable" } };
      throw new Error(`unexpected ${request.path}`);
    });
    render(<CompletedReviewFlow workbench={workbench} onWorkbenchPatch={() => {}} onNavigationStateChange={() => {}} />);

    fireEvent.click(await screen.findByRole("button", { name: "Generate walkthrough" }));

    const confirm = await screen.findByRole("button", { name: "Generate read-only walkthrough" });
    await waitFor(() => expect((confirm as HTMLButtonElement).disabled).toBe(true));
    expect(await screen.findByText("No enabled review model is currently available. Try again after review models are available.")).toBeTruthy();
    // The confirm button uses a busy label "Generating…" while the previous request is in flight.
    // The unavailable case skips the disabled state because the request was never made; double-check the dialog is still rendered.
    expect(screen.getByTestId("walkthrough-generate-dialog")).toBeTruthy();
  });

  it("persists the model and reasoning preference only after a valid confirmation", async () => {
    const storage = new Map<string, string>();
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        getItem: vi.fn((key: string) => storage.get(key) ?? null),
        setItem: vi.fn((key: string, value: string) => { storage.set(key, value); }),
        removeItem: vi.fn((key: string) => { storage.delete(key); }),
        clear: vi.fn(() => { storage.clear(); }),
      },
    });
    const requests: Array<{ path: string; body: unknown }> = [];
    mockApi((request) => {
      requests.push({ path: request.path, body: request.body });
      if (request.path === "/v1/reviews/models") return ok200({ ...models, defaultModel: "model-2", models: [{ id: "model-1", label: "Model One" }, { id: "model-2", label: "Model Two" }] });
      if (request.path === "/v1/reviews/walkthrough/generate") return ok200(projection.ready);
      throw new Error(`unexpected ${request.path}`);
    });
    render(<CompletedReviewFlow workbench={workbench} onWorkbenchPatch={() => {}} onNavigationStateChange={() => {}} />);

    fireEvent.click(await screen.findByRole("button", { name: "Generate walkthrough" }));
    const dialog = screen.getByTestId("walkthrough-generate-dialog");

    const modelTriggers = dialog.querySelectorAll('[data-slot="select-trigger"]');
    fireEvent.click(modelTriggers[0] as HTMLElement);
    const modelTwo = await screen.findByRole("option", { name: "Model Two" });
    fireEvent.click(modelTwo);

    const confirm = await screen.findByRole("button", { name: "Generate read-only walkthrough" });
    fireEvent.click(confirm);

    await waitFor(() => expect(requests.find((request) => request.path === "/v1/reviews/walkthrough/generate")).toBeDefined());
    const generate = requests.find((request) => request.path === "/v1/reviews/walkthrough/generate");
    expect(generate?.body).toMatchObject({ model: "model-2" });
    expect(storage.get("patchdesk.review-execution.v1.cfw")).toBe("{\"model\":\"model-2\",\"reasoning\":\"medium\"}");
  });

  it("shows the failed projection with a retry action bound to the same session", async () => {
    const requests: Array<string> = [];
    mockApi((request) => {
      requests.push(request.path);
      if (request.path === "/v1/reviews/models") return ok200(models);
      if (request.path === "/v1/reviews/walkthrough/generate") return ok200({ lifecycle: "failed", noticeKey: "walkthrough-failed", actionKey: "walkthrough-retry" });
      throw new Error(`unexpected ${request.path}`);
    });
    render(<CompletedReviewFlow workbench={workbench} onWorkbenchPatch={() => {}} onNavigationStateChange={() => {}} />);

    fireEvent.click(await screen.findByRole("button", { name: "Generate walkthrough" }));
    fireEvent.click(await screen.findByRole("button", { name: "Generate read-only walkthrough" }));

    const retry = await screen.findByRole("button", { name: "Retry generation" });
    expect(retry).toBeTruthy();
    fireEvent.click(retry);

    await waitFor(() => expect(requests.filter((path) => path === "/v1/reviews/walkthrough/generate").length).toBeGreaterThanOrEqual(2));
  });

  it("shows the stale projection with a regenerate action bound to the same snapshot", async () => {
    const requests: Array<string> = [];
    mockApi((request) => {
      requests.push(request.path);
      if (request.path === "/v1/reviews/models") return ok200(models);
      if (request.path === "/v1/reviews/walkthrough/generate") return ok200({ lifecycle: "stale", noticeKey: "walkthrough-stale", actionKey: "walkthrough-regenerate" });
      throw new Error(`unexpected ${request.path}`);
    });
    render(<CompletedReviewFlow workbench={workbench} onWorkbenchPatch={() => {}} onNavigationStateChange={() => {}} />);

    fireEvent.click(await screen.findByRole("button", { name: "Generate walkthrough" }));
    fireEvent.click(await screen.findByRole("button", { name: "Generate read-only walkthrough" }));

    const regenerate = await screen.findByRole("button", { name: "Generate walkthrough" });
    fireEvent.click(regenerate);

    const dialog = screen.getByTestId("walkthrough-generate-dialog");
    expect(dialog).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Generate read-only walkthrough" }));

    await waitFor(() => expect(requests.filter((path) => path === "/v1/reviews/walkthrough/generate").length).toBeGreaterThanOrEqual(2));
  });

  it("does not run generation when the projection is unavailable", async () => {
    const requests: Array<string> = [];
    mockApi((request) => {
      requests.push(request.path);
      if (request.path === "/v1/reviews/models") return ok200(models);
      throw new Error(`unexpected ${request.path}`);
    });
    render(<CompletedReviewFlow workbench={workbench} onWorkbenchPatch={() => {}} onNavigationStateChange={() => {}} />);

    expect(await screen.findByRole("button", { name: "Generate walkthrough" })).toBeTruthy();
    expect(requests).not.toContain("/v1/reviews/walkthrough/generate");
  });

  it("ignores stale responses after the workbench session identity changes", async () => {
    // Keep the walkthrough-generate request pending until the test deliberately resolves it.
    let resolveGenerate: ((value: ReturnType<typeof ok200>) => void) | undefined;
    const pendingGenerate = new Promise<ReturnType<typeof ok200>>((resolve) => {
      resolveGenerate = resolve;
    });
    pendingGenerate.catch(() => undefined);
    const requests: Array<{ path: string; body: unknown }> = [];
    mockApi((request) => {
      requests.push({ path: request.path, body: request.body });
      if (request.path === "/v1/reviews/models") return ok200(models);
      if (request.path === "/v1/reviews/walkthrough/generate") return pendingGenerate;
      throw new Error(`unexpected ${request.path}`);
    });

    const differentWorkbench: CompletedReviewFlowWorkbench = {
      ...workbench,
      session: { ...workbench.session, id: "different-session" },
      reviewedHeadSha: "3333333333333333333333333333333333333333",
    };

    const { rerender } = render(
      <CompletedReviewFlow workbench={workbench} onWorkbenchPatch={() => {}} onNavigationStateChange={() => {}} />,
    );

    // Click the manual banner button to open the dialog, then click the confirm button. The request fires but stays pending.
    fireEvent.click(await screen.findByRole("button", { name: "Generate walkthrough" }));
    fireEvent.click(await screen.findByRole("button", { name: "Generate read-only walkthrough" }));

    await waitFor(() => expect(requests.filter((request) => request.path === "/v1/reviews/walkthrough/generate").length).toBe(1));

    // Re-render with a different workbench session identity (session id and reviewed head) before the original request resolves.
    rerender(
      <CompletedReviewFlow workbench={differentWorkbench} onWorkbenchPatch={() => {}} onNavigationStateChange={() => {}} />,
    );

    // Resolve the original request. The stale ready projection must NOT enter the new workbench's state.
    resolveGenerate?.(ok200(projection.ready));
    await new Promise<void>((flush) => setTimeout(flush, 0));

    // The banner on the new workbench is still in the idle lifecycle (headline "Generate a read-only walkthrough"), not the ready lifecycle ("Read-only walkthrough ready").
    const banner = await screen.findByTestId("walkthrough-banner");
    expect(banner.textContent).toContain("Generate a read-only walkthrough");
    expect(banner.textContent).not.toContain("Read-only walkthrough ready");

    // No new generation request fires for the new workbench; the original request is the only one.
    expect(requests.filter((request) => request.path === "/v1/reviews/walkthrough/generate").length).toBe(1);
  });

  it("does not auto-request walkthrough generation when the workbench opens", async () => {
    const requests: Array<string> = [];
    mockApi((request) => {
      requests.push(request.path);
      if (request.path === "/v1/reviews/models") return ok200(models);
      throw new Error(`unexpected ${request.path}`);
    });
    render(<CompletedReviewFlow workbench={workbench} onWorkbenchPatch={() => {}} onNavigationStateChange={() => {}} />);

    // Open the dialog and close it; assert no walkthrough generation request fires.
    fireEvent.click(await screen.findByRole("button", { name: "Generate walkthrough" }));
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));

    expect(requests).not.toContain("/v1/reviews/walkthrough/generate");
    expect(requests).not.toContain("/v1/reviews/walkthrough/load");
  });

  it("ignores stale responses after the reviewed head changes for the same session", async () => {
    // Keep the walkthrough-generate request pending; only the reviewed HEAD changes between click and resolution.
    let resolveGenerate: ((value: ReturnType<typeof ok200>) => void) | undefined;
    const pendingGenerate = new Promise<ReturnType<typeof ok200>>((resolve) => {
      resolveGenerate = resolve;
    });
    pendingGenerate.catch(() => undefined);
    const requests: Array<{ path: string; body: unknown }> = [];
    mockApi((request) => {
      requests.push({ path: request.path, body: request.body });
      if (request.path === "/v1/reviews/models") return ok200(models);
      if (request.path === "/v1/reviews/walkthrough/generate") return pendingGenerate;
      throw new Error(`unexpected ${request.path}`);
    });

    const headChangedWorkbench: CompletedReviewFlowWorkbench = {
      ...workbench,
      // Same session id, different reviewed HEAD.
      reviewedHeadSha: "4444444444444444444444444444444444444444",
    };

    const { rerender } = render(
      <CompletedReviewFlow workbench={workbench} onWorkbenchPatch={() => {}} onNavigationStateChange={() => {}} />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Generate walkthrough" }));
    fireEvent.click(await screen.findByRole("button", { name: "Generate read-only walkthrough" }));

    await waitFor(() => expect(requests.filter((request) => request.path === "/v1/reviews/walkthrough/generate").length).toBe(1));

    rerender(
      <CompletedReviewFlow workbench={headChangedWorkbench} onWorkbenchPatch={() => {}} onNavigationStateChange={() => {}} />,
    );

    resolveGenerate?.(ok200(projection.ready));
    await new Promise<void>((flush) => setTimeout(flush, 0));

    // The new workbench must not have advanced to the ready projection.
    const banner = await screen.findByTestId("walkthrough-banner");
    expect(banner.textContent).toContain("Generate a read-only walkthrough");
    expect(banner.textContent).not.toContain("Read-only walkthrough ready");
  });
});
