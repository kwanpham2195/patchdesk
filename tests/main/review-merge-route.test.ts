import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";

import { PatchdeskPaths } from "../../src/adapters/storage/patchdesk-paths";
import {
  startLocalApiServer,
  type LocalApiServer,
} from "../../src/main/local-api";
import { registerReviewLifecycleRoutes } from "../../src/main/routes/review-lifecycle-routes";
import { parseMergeReceipt } from "../../src/renderer/src/review-write-receipts";

const capability = "test-capability";
const origin = "http://patchdesk.test";
let server: LocalApiServer | undefined;
let root: string | undefined;

afterEach(async () => {
  await server?.stop();
  server = undefined;
  if (root !== undefined)
    await rm(root, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 50,
    });
  root = undefined;
});

async function start(): Promise<LocalApiServer> {
  root = await mkdtemp(join(tmpdir(), "patchdesk-merge-route-"));
  const value = await startLocalApiServer({
    capability,
    allowedOrigin: origin,
    paths: PatchdeskPaths.forTest(root),
  });
  if (value._tag !== "started") throw new Error("local API did not start");
  server = value.server;
  return server;
}

async function postMerge(
  api: LocalApiServer,
  body: typeof validMergeBody & { readonly extra?: boolean },
): Promise<number> {
  const response = await fetch(new URL("v1/reviews/merge", api.url), {
    method: "POST",
    headers: {
      Origin: origin,
      "X-Patchdesk-Capability": capability,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  return response.status;
}

const headSha = "a".repeat(40);
const baseSha = "b".repeat(40);
const patchHash = "c".repeat(64);

/** The renderer's merge payload (`use-review-merge-action.ts`) with fixture values that pass every id parser. */
const validMergeBody = {
  profileId: "profile",
  reviewId: "github.com__octo-org__patchdesk__pr-42__review-abcdef123456",
  sessionId:
    "github.com__octo-org__patchdesk__pr-42__sha-aaaaaaaa__base-bbbbbbbb__abcdef123456",
  expectedHeadSha: headSha,
  expectedBaseSha: baseSha,
  expectedPatchHash: patchHash,
  expectedRevision: "2026-09-16T00:00:00.000Z",
  method: "squash",
  acknowledgedWarnings: {
    revision: { headSha, baseSha, patchHash },
    warningCodes: [],
  },
};

describe("POST /v1/reviews/merge input", () => {
  it("rejects an unknown field", async () => {
    const api = await start();
    expect(await postMerge(api, { ...validMergeBody, extra: true })).toBe(400);
  });

  it("rejects a merge method outside merge, squash, and rebase", async () => {
    const api = await start();
    expect(await postMerge(api, { ...validMergeBody, method: "delete" })).toBe(
      400,
    );
  });

  it("rejects a head SHA the id parser refuses", async () => {
    const api = await start();
    expect(
      await postMerge(api, { ...validMergeBody, expectedHeadSha: "not-a-sha" }),
    ).toBe(400);
  });
});

describe("POST /v1/reviews/merge confirmation", () => {
  it("answers a confirmed merge with a body the renderer's receipt parser accepts", async () => {
    const app = new Hono();
    // SAFETY: the merge route reads only `mergeWrites` from the container.
    const container = {
      mergeWrites: {
        // The controller's receipt carries the stored Review, which the renderer's strict parser refuses.
        merge: async () => ({
          _tag: "ok" as const,
          value: {
            readiness: { _tag: "Ready" as const, blockers: [], warnings: [] },
            review: { id: "stored-review", status: "merged" },
            mergeCommitSha: "d".repeat(40),
          },
        }),
      },
    } as never;
    registerReviewLifecycleRoutes(app, container);

    const reply = await app.request("/v1/reviews/merge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validMergeBody),
    });

    expect(reply.status).toBe(200);
    expect(parseMergeReceipt(await reply.json())).toEqual({
      readiness: { _tag: "Ready", blockers: [], warnings: [] },
      mergeCommitSha: "d".repeat(40),
    });
  });
});
