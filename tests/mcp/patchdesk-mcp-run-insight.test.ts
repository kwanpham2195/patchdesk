import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import * as v from "valibot";
import { afterEach, describe, expect, it } from "vitest";

import { InsightStore } from "../../src/adapters/storage/insight-store";
import {
  parseContentHash,
  parseGitSha,
  parseReviewId,
  parseReviewSessionId,
} from "../../src/domain/ids";
import { parseWorkbenchResponse } from "../../src/renderer/src/renderer-contracts";
import type { DesktopNotificationEvent } from "../../src/services/desktop-notifier";
import {
  startAppWithLinkedWorktree,
  type McpAppFixture,
} from "../main/mcp-app-fixture";
import {
  closeMcpTestClients,
  connectLegacyClient,
  mcpProtocolEras,
} from "./mcp-test-clients";
import { beginRun, value } from "../services/local-apply-fixture";
import { call, openRoute, type Workbench } from "./mcp-read-tools-fixture";

let app: McpAppFixture | undefined;

afterEach(async () => {
  await closeMcpTestClients();
  await app?.stop();
  app = undefined;
});

const requestedSchema = v.looseObject({ requestId: v.string() });

describe.each(mcpProtocolEras)(
  "run_insight on the $era era",
  ({ connect, clientName }) => {
    it("records one request with one notification, answers repeats with it, and stays declined after the decline route", async () => {
      const events: DesktopNotificationEvent[] = [];
      app = await startAppWithLinkedWorktree({
        desktopNotifier: { notify: (event) => events.push(event) },
      });
      const fixture = app;
      const workbench = await openRoute(fixture, fixture.repositoryPath);
      const client = await connect(fixture.socketPath);
      const ask = {
        reviewId: workbench.review.id,
        sessionId: workbench.session.id,
        type: "analysis",
      };

      const first = await call(client, "run_insight", ask);
      const repeated = await call(client, "run_insight", ask);
      const awaiting = await call(client, "get_insight", {
        reviewId: workbench.review.id,
        type: "analysis",
      });
      // The renderer's own parse, so the Agent requests bar reads what the projection sends.
      const shown = parseWorkbenchResponse(
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
      const { requestId } = v.parse(requestedSchema, first.content);
      const declined = await fixture.route(
        "v1/reviews/insights/agent-requests/decline",
        JSON.stringify({
          profileId: "acme",
          reviewId: workbench.review.id,
          requestId,
        }),
      );
      const afterDecline = await call(client, "run_insight", ask);
      const declinedInsight = await call(client, "get_insight", {
        reviewId: workbench.review.id,
        type: "analysis",
      });

      expect(first).toEqual({
        isError: false,
        content: {
          reviewId: workbench.review.id,
          sessionId: workbench.session.id,
          type: "analysis",
          status: "awaiting_approval",
          requestId,
        },
      });
      expect(repeated.content).toEqual(first.content);
      expect(awaiting.content).toMatchObject({
        status: "awaiting_approval",
        requestId,
        sessionId: workbench.session.id,
      });
      expect(shown?.agentRunRequests).toEqual([
        expect.objectContaining({
          requestId,
          status: "awaiting_approval",
          clientName,
        }),
      ]);
      expect(declined.status).toBe(200);
      expect(afterDecline.content).toMatchObject({
        status: "declined",
        requestId,
      });
      expect(declinedInsight.content).toMatchObject({ status: "declined" });
      expect(events).toEqual([
        expect.objectContaining({
          _tag: "AgentRunRequested",
          reviewId: workbench.review.id,
          insightType: "analysis",
        }),
      ]);
    });
  },
);

describe("run_insight after the maintainer's Refresh", () => {
  it("refuses the session the Review moved past as stale_session, and get_insight reads the new session with no request", async () => {
    app = await startAppWithLinkedWorktree();
    const fixture = app;
    const probe = join(fixture.repositoryPath, "probe.txt");
    await writeFile(probe, "one\n");
    const workbench = await openRoute(fixture, fixture.repositoryPath);
    const client = await connectLegacyClient(fixture.socketPath);
    const ask = {
      reviewId: workbench.review.id,
      sessionId: workbench.session.id,
      type: "brief",
    };
    await call(client, "run_insight", ask);
    await writeFile(probe, "two\n");
    await fixture.route(
      "v1/reviews/local-refresh",
      JSON.stringify({ profileId: "acme", reviewId: workbench.review.id }),
    );

    const refused = await call(client, "run_insight", ask);
    const insight = await call(client, "get_insight", {
      reviewId: workbench.review.id,
      type: "brief",
    });

    expect(refused).toMatchObject({
      isError: true,
      content: { error: "stale_session" },
    });
    expect(insight.content).toMatchObject({ status: "none" });
    expect(insight.content).not.toHaveProperty("requestId");
    expect(insight.content).not.toMatchObject({
      sessionId: workbench.session.id,
    });
  });
});

/** Begins a run of `type` on the workbench's session, as the maintainer's Run button does. */
async function beginRunOn(
  fixture: McpAppFixture,
  workbench: Workbench,
  type: "analysis" | "walkthrough",
): Promise<void> {
  await beginRun(
    new InsightStore(fixture.paths),
    {
      review: { id: value(parseReviewId(workbench.review.id)) },
      session: {
        id: value(parseReviewSessionId(workbench.session.id)),
        key: { headSha: value(parseGitSha(workbench.session.key.headSha)) },
      },
      revision: {
        patchHash: value(parseContentHash(workbench.revision.patchHash)),
      },
    },
    type,
  );
}

describe("run_insight beside a run the maintainer started", () => {
  it("answers running with the run's id and records no request when that type already runs on the session", async () => {
    const events: DesktopNotificationEvent[] = [];
    app = await startAppWithLinkedWorktree({
      desktopNotifier: { notify: (event) => events.push(event) },
    });
    const workbench = await openRoute(app, app.repositoryPath);
    await beginRunOn(app, workbench, "walkthrough");
    const client = await connectLegacyClient(app.socketPath);

    const asked = await call(client, "run_insight", {
      reviewId: workbench.review.id,
      sessionId: workbench.session.id,
      type: "walkthrough",
    });

    expect(asked.content).toMatchObject({
      status: "running",
      runId: expect.any(String),
    });
    expect(asked.content).not.toHaveProperty("requestId");
    expect(events).toEqual([]);
  });

  it("has get_insight report the active run, not the awaiting request, once a run of that type starts on the session", async () => {
    app = await startAppWithLinkedWorktree();
    const workbench = await openRoute(app, app.repositoryPath);
    const client = await connectLegacyClient(app.socketPath);
    const asked = await call(client, "run_insight", {
      reviewId: workbench.review.id,
      sessionId: workbench.session.id,
      type: "analysis",
    });
    await beginRunOn(app, workbench, "analysis");

    const insight = await call(client, "get_insight", {
      reviewId: workbench.review.id,
      type: "analysis",
    });

    expect(insight.content).toMatchObject({
      status: "running",
      requestId: v.parse(requestedSchema, asked.content).requestId,
    });
  });
});
