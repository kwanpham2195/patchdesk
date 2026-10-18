import { readBoundedInsightArtifactFile } from "#src/adapters/storage/insight-artifact-files";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FakeGitHubAdapter } from "#src/adapters/github/github-adapter";
import { PatchdeskPaths } from "#src/adapters/storage/patchdesk-paths";
import { err, ok } from "#src/domain/result";
import type { RawJsonValue } from "#src/domain/json";
import type {
  GuideReadingStateInput,
  GuideReadingStateFailure,
} from "#src/services/guide-reading-state-service";
import type { InsightCoordinatorSeam } from "#src/main/local-api-configuration";
import { startLocalApiServer, type LocalApiServer } from "#src/main/local-api";
import { AppLogService } from "#src/services/app-log-service";

const origin = "http://patchdesk.test";
const capability = "guide-reading-test";
const input = {
  profileId: "acme",
  reviewId: "github.com__octo-org__patchdesk__pr-42__review-aaaaaaaaaaaa",
  runId:
    "insight-guide-1-aaaaaaaaaaaa-github.com__octo-org__patchdesk__pr-42__review-aaaaaaaaaaaa",
  sessionId:
    "github.com__octo-org__patchdesk__pr-42__sha-aaaaaaaa__base-00000000__b48f8e2e76ca",
  expectedStateVersion: 3,
  state: {
    reviewedGroupIds: ["g1"],
    expandedAppearances: [{ groupId: "g1", fileId: "f1" }],
    anchor: { kind: "file" as const, groupId: "g1", fileId: "f1", offset: 24 },
  },
};
let server: LocalApiServer | undefined;
let root: string | undefined;
let logs: AppLogService | undefined;
afterEach(async () => {
  await server?.stop();
  server = undefined;
  await logs?.flush();
  logs = undefined;
  if (root !== undefined) await rm(root, { recursive: true, force: true });
  root = undefined;
});

async function setup(
  calls: GuideReadingStateInput[],
  refusal?: GuideReadingStateFailure,
) {
  root = await mkdtemp(join(tmpdir(), "patchdesk-guide-route-"));
  const paths = PatchdeskPaths.forTest(root);
  logs = new AppLogService(paths);
  const insights: InsightCoordinatorSeam = {
    start: async () => err("not_found"),
    cancel: async () => err("not_found"),
    observe: async () => err("not_found"),
    dismissFinding: async () => err("not_found"),
    restoreFinding: async () => err("not_found"),
    resolveFindingSuggestion: async () => err("not_found"),
    async updateGuideReadingState(body) {
      calls.push(body);
      return refusal === undefined
        ? ok({
            ...input.state,
            runId: body.runId,
            sessionId: body.sessionId,
            version: 4,
          })
        : err(refusal);
    },
  };
  const started = await startLocalApiServer({
    insightArtifactReader: readBoundedInsightArtifactFile,
    allowedOrigin: origin,
    capability,
    paths,
    logs,
    github: new FakeGitHubAdapter({}),
    insights: async () => insights,
  });
  if (started._tag !== "started") throw new Error("Local API failed to start");
  server = started.server;
}
async function send(body: RawJsonValue): Promise<Response> {
  if (server === undefined) throw new Error("Local API not started");
  return fetch(new URL("v1/reviews/insights/guide/reading-state", server.url), {
    method: "POST",
    headers: {
      Origin: origin,
      "X-Patchdesk-Capability": capability,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}
describe("Guide reading-state route", () => {
  it("forwards represented identity, expected version and content to the owning service", async () => {
    const calls: GuideReadingStateInput[] = [];
    await setup(calls);
    const response = await send(input);
    expect(response.status).toBe(200);
    expect(calls[0]).toMatchObject(input);
    expect(await response.json()).toMatchObject({
      runId: input.runId,
      sessionId: input.sessionId,
      version: 4,
      anchor: input.state.anchor,
    });
  });
  it.each([
    [-1, "negative"],
    [0.5, "fractional"],
    [Number.MAX_SAFE_INTEGER + 1, "unsafe integer"],
  ] as const)(
    "rejects a %s expected version (%s) before the service",
    async (expectedStateVersion, _reason) => {
      const calls: GuideReadingStateInput[] = [];
      await setup(calls);
      expect((await send({ ...input, expectedStateVersion })).status).toBe(400);
      expect(calls).toEqual([]);
    },
  );
  it.each([
    ["guide_identity_conflict", 409],
    ["guide_version_conflict", 409],
    ["invalid_reading_state", 400],
    ["storage_unavailable", 503],
  ] as const)(
    "maps %s to HTTP %s without reporting a save",
    async (reason, status) => {
      await setup([], reason);
      const response = await send(input);
      expect(response.status).toBe(status);
      expect(await response.json()).toEqual({ error: reason });
    },
  );
});
