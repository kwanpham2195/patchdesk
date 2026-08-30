import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it } from "vitest";

import { FakeGitHubAdapter } from "../../src/adapters/github/github-adapter";
import { PatchdeskPaths } from "../../src/adapters/storage/patchdesk-paths";
import { ok } from "../../src/domain/result";
import {
  startLocalApiServer,
  type LocalApiServer,
} from "../../src/main/local-api";

// The Brief run and cancel routes are the third arm of the Insight lifecycle.
// This proves the route exists, parses a `brief` body, and reaches the
// coordinator with the type it was registered under -- the coordinator itself
// is covered in tests/services/insight-run-coordinator.test.ts.

const capability = "cap";
const origin = "http://patchdesk.test";
const runId = "insight-brief-1-aaaaaaaaaaaa-review";
let server: LocalApiServer | undefined;
let root: string | undefined;

afterEach(async () => {
  if (server !== undefined) await server.stop();
  server = undefined;
  if (root !== undefined)
    await rm(root, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  root = undefined;
});

it("accepts a Brief run and a Brief cancel through the local API", async () => {
  root = await mkdtemp(join(tmpdir(), "patchdesk-brief-route-"));
  const calls: Array<string> = [];
  const started = await startLocalApiServer({
    allowedOrigin: origin,
    capability,
    paths: PatchdeskPaths.forTest(root),
    github: new FakeGitHubAdapter({}),
    // SAFETY: the Insight routes call only `start` and `cancel` here; casting
    // to `never` stands in for the full coordinator interface the
    // configuration declares.
    insights: {
      async start(input: { readonly type: string }) {
        calls.push(`start:${input.type}`);
        return ok({ runId, type: input.type, status: "queued" });
      },
      async cancel(input: { readonly type: string }) {
        calls.push(`cancel:${input.type}`);
        return ok({ runId, type: input.type, status: "cancelling" });
      },
    } as never,
  });
  if (started._tag !== "started") throw new Error("local API did not start");
  server = started.server;

  expect(
    await call("v1/reviews/insights/brief/run", {
      profileId: "cfw",
      reviewId:
        "github.com__centraldigital__patchdesk__pr-42__review-aaaaaaaaaaaa",
      type: "brief",
      provider: "pi",
      model: "model",
      reasoning: "medium",
    }),
  ).toBe(202);
  expect(
    await call("v1/reviews/insights/brief/cancel", {
      profileId: "cfw",
      reviewId:
        "github.com__centraldigital__patchdesk__pr-42__review-aaaaaaaaaaaa",
      type: "brief",
      runId,
    }),
  ).toBe(200);
  expect(calls).toEqual(["start:brief", "cancel:brief"]);

  // A body naming another type must not reach the coordinator through the
  // Brief route, the way the analysis and walkthrough routes already behave.
  expect(
    await call("v1/reviews/insights/brief/run", {
      profileId: "cfw",
      reviewId:
        "github.com__centraldigital__patchdesk__pr-42__review-aaaaaaaaaaaa",
      type: "analysis",
      provider: "pi",
      model: "model",
      reasoning: "medium",
    }),
  ).toBe(400);
});

async function call(
  path: string,
  body: Readonly<Record<string, string>>,
): Promise<number> {
  if (server === undefined) throw new Error("server not started");
  const response = await fetch(new URL(path, server.url), {
    method: "POST",
    headers: {
      Origin: origin,
      "Content-Type": "application/json",
      "X-Patchdesk-Capability": capability,
    },
    body: JSON.stringify(body),
  });
  return response.status;
}
