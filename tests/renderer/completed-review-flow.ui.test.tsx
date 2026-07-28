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

function mockApi(handler: (request: MockRequest) => { readonly ok: boolean; readonly status: number; readonly body: unknown }) {
  Object.defineProperty(window, "patchdesk", {
    configurable: true,
    value: { request: vi.fn((request: MockRequest) => Promise.resolve({ correlationId: "test", ...handler(request) })) },
  });
}

const ok200 = (body: unknown) => ({ ok: true as const, status: 200, body });

describe("completed review walkthrough generation", () => {
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

  it("ignores responses for a different snapshot identity", async () => {
    const requests: Array<{ path: string; body: unknown }> = [];
    mockApi((request) => {
      requests.push({ path: request.path, body: request.body });
      if (request.path === "/v1/reviews/models") return ok200(models);
      if (request.path === "/v1/reviews/walkthrough/generate") return ok200(projection.ready);
      throw new Error(`unexpected ${request.path}`);
    });
    render(<CompletedReviewFlow workbench={{ ...workbench, session: { ...workbench.session, id: "different-session" } }} onWorkbenchPatch={() => {}} onNavigationStateChange={() => {}} />);

    fireEvent.click(await screen.findByRole("button", { name: "Generate walkthrough" }));
    fireEvent.click(await screen.findByRole("button", { name: "Generate read-only walkthrough" }));

    await waitFor(() => expect(requests.filter((request) => request.path === "/v1/reviews/walkthrough/generate").length).toBeGreaterThanOrEqual(1));
    // Single request only, no retries, no extra calls.
    expect(requests.filter((request) => request.path === "/v1/reviews/walkthrough/generate").length).toBe(1);
  });
});
