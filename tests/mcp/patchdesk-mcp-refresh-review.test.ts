import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import * as v from "valibot";
import { afterEach, describe, expect, it } from "vitest";

import {
  startAppWithLinkedWorktree,
  type McpAppFixture,
} from "../main/mcp-app-fixture";
import {
  closeMcpTestClients,
  connectLegacyClient,
  mcpProtocolEras,
} from "./mcp-test-clients";
import { call, openRoute } from "./mcp-read-tools-fixture";

let app: McpAppFixture | undefined;

afterEach(async () => {
  await closeMcpTestClients();
  await app?.stop();
  app = undefined;
});

const preparedSchema = v.looseObject({
  preparedSessionId: v.string(),
  headSha: v.string(),
});

const shownSchema = v.looseObject({
  session: v.looseObject({ id: v.string() }),
  revision: v.looseObject({ freshness: v.string() }),
});

/** The observation tag the renderer's detection reads for the Review. */
async function detectRoute(
  fixture: McpAppFixture,
  reviewId: string,
): Promise<string> {
  const detected = await fixture.route(
    "v1/reviews/detect-updates",
    JSON.stringify({ profileId: "acme", reviewId }),
  );
  return v.parse(v.looseObject({ _tag: v.string() }), detected.body)._tag;
}

describe.each(mcpProtocolEras)(
  "refresh_review on the $era era",
  ({ connect }) => {
    it("prepares the edited checkout without moving the Review, which the local-refresh route then moves to the prepared session", async () => {
      app = await startAppWithLinkedWorktree();
      const fixture = app;
      const probe = join(fixture.repositoryPath, "probe.txt");
      await writeFile(probe, "one\n");
      const workbench = await openRoute(fixture, fixture.repositoryPath);
      await writeFile(probe, "two\n");
      const client = await connect(fixture.socketPath);

      const refreshed = await call(client, "refresh_review", {
        reviewId: workbench.review.id,
      });
      const shown = v.parse(
        shownSchema,
        (
          await fixture.route(
            "v1/reviews/load",
            JSON.stringify({
              profileId: "acme",
              reviewId: workbench.review.id,
            }),
          )
        ).body,
      );
      const detected = await detectRoute(fixture, workbench.review.id);
      const moved = v.parse(
        shownSchema,
        (
          await fixture.route(
            "v1/reviews/local-refresh",
            JSON.stringify({
              profileId: "acme",
              reviewId: workbench.review.id,
            }),
          )
        ).body,
      );

      expect(refreshed.isError).toBe(false);
      expect(refreshed.content).toMatchObject({
        reviewId: workbench.review.id,
        sessionId: workbench.session.id,
        changed: true,
      });
      const prepared = v.parse(preparedSchema, refreshed.content);
      expect(prepared.preparedSessionId).not.toBe(workbench.session.id);
      expect(shown.session.id).toBe(workbench.session.id);
      expect(shown.revision.freshness).toBe("updates_available");
      expect(detected).toBe("RevisionChanged");
      expect(moved.session.id).toBe(prepared.preparedSessionId);
      expect(moved.revision.freshness).toBe("fresh");
      expect(await detectRoute(fixture, workbench.review.id)).toBe("Unchanged");
    });

    it("refuses a second refresh_review of the Review within 10 s as rate_limited with retryAfterMs", async () => {
      app = await startAppWithLinkedWorktree();
      const workbench = await openRoute(app, app.repositoryPath);
      const client = await connect(app.socketPath);

      const first = await call(client, "refresh_review", {
        reviewId: workbench.review.id,
      });
      const second = await call(client, "refresh_review", {
        reviewId: workbench.review.id,
      });

      expect(first.content).toMatchObject({ changed: false });
      expect(second.isError).toBe(true);
      expect(second.content).toMatchObject({
        error: "rate_limited",
        retryAfterMs: expect.any(Number),
      });
      const { retryAfterMs } = v.parse(
        v.looseObject({ retryAfterMs: v.number() }),
        second.content,
      );
      expect(retryAfterMs).toBeGreaterThan(0);
      expect(retryAfterMs).toBeLessThanOrEqual(10_000);
    });
  },
);

describe("refresh_review refusals", () => {
  it("refuses a working-tree Review whose checkout switched branch, naming the branch it is on", async () => {
    app = await startAppWithLinkedWorktree();
    const workbench = await openRoute(app, app.repositoryPath);
    execFileSync("git", [
      "-C",
      app.repositoryPath,
      "checkout",
      "-q",
      "-b",
      "other",
    ]);
    const client = await connectLegacyClient(app.socketPath);

    const refused = await call(client, "refresh_review", {
      reviewId: workbench.review.id,
    });

    expect(refused.isError).toBe(true);
    expect(refused.content).toMatchObject({
      error: "branch_mismatch",
      message: expect.stringContaining("on branch other"),
    });
  });
});
