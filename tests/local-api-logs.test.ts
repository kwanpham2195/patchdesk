import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  startLocalApiServer,
  type LocalApiServer,
} from "../src/main/local-api";
import { PatchdeskPaths } from "../src/adapters/storage/patchdesk-paths";
import { AppLogService } from "../src/services/app-log-service";

const capability = "test-only-capability";
const allowedOrigin = "http://patchdesk.local";
let localApi: LocalApiServer | undefined;

afterEach(async () => {
  if (localApi !== undefined) {
    await localApi.stop();
    localApi = undefined;
  }
});

async function authHeaders(correlationId?: string): Promise<Headers> {
  const headers = new Headers({
    Origin: allowedOrigin,
    "X-Patchdesk-Capability": capability,
    "Content-Type": "application/json",
  });
  if (correlationId !== undefined)
    headers.set("X-Patchdesk-Correlation-Id", correlationId);
  return headers;
}

describe("local API log stream", () => {
  it("accepts renderer entries and tails them with redaction", async () => {
    const paths = PatchdeskPaths.forTest(
      await mkdtemp(join(tmpdir(), "patchdesk-logs-api-")),
    );
    const logs = new AppLogService(paths);
    const startup = await startLocalApiServer({
      capability,
      allowedOrigin,
      paths,
      logs,
    });
    if (startup._tag !== "started")
      throw new Error("Expected local API startup");
    localApi = startup.server;

    const posted = await fetch(new URL("v1/logs", localApi.url), {
      method: "POST",
      headers: await authHeaders(),
      body: JSON.stringify({
        entries: [
          {
            level: "warn",
            topic: "api",
            message:
              "POST /v1/removed-review-command failed with ghp_1234567890abcdef",
          },
          {
            process: "main",
            level: "error",
            topic: "api",
            message: "entry claiming a process is rejected",
          },
          { level: "debug", topic: "api", message: "ok" },
        ],
      }),
    });
    expect(posted.status).toBe(200);
    expect(await posted.json()).toEqual({ accepted: 2 });

    const tailed = await fetch(new URL("v1/logs", localApi.url), {
      headers: await authHeaders(),
    });
    expect(tailed.status).toBe(200);
    const body = (await tailed.json()) as {
      entries: Array<{ process: string; message: string }>;
      nextAfter?: number;
    };
    const renderer = body.entries.filter(
      (entry) => entry.process === "renderer",
    );
    expect(renderer).toHaveLength(2);
    expect(renderer[0]?.message).not.toContain("ghp_1234567890abcdef");
    expect(renderer[0]?.message).toContain(
      "POST /v1/removed-review-command failed",
    );
    // The cursor is the last delivered sequence, so the next poll resumes
    // exactly after the entries this response delivered.
    expect(body.nextAfter).toBe(body.entries.length - 1);
  });

  it("returns an exclusive-resume cursor that never skips the first entry after a poll", async () => {
    const paths = PatchdeskPaths.forTest(
      await mkdtemp(join(tmpdir(), "patchdesk-logs-cursor-")),
    );
    const logs = new AppLogService(paths);
    const startup = await startLocalApiServer({
      capability,
      allowedOrigin,
      paths,
      logs,
    });
    if (startup._tag !== "started")
      throw new Error("Expected local API startup");
    const server = startup.server;
    localApi = server;

    const post = async (message: string): Promise<void> => {
      const response = await fetch(new URL("v1/logs", server.url), {
        method: "POST",
        headers: await authHeaders(),
        body: JSON.stringify({
          entries: [{ level: "info", topic: "api", message }],
        }),
      });
      expect(response.status).toBe(200);
    };
    await post("one");
    await post("two");
    const first = (await (
      await fetch(new URL("v1/logs", server.url), {
        headers: await authHeaders(),
      })
    ).json()) as {
      entries: Array<{ process: string; message: string }>;
      nextAfter?: number;
    };
    expect(
      first.entries
        .filter((entry) => entry.process === "renderer")
        .map((entry) => entry.message),
    ).toEqual(["one", "two"]);
    expect(first.nextAfter).toBeDefined();
    // The next entry arrives before the next poll; resuming with the returned
    // cursor must deliver it exactly once.
    await post("three");
    const resumed = (await (
      await fetch(new URL(`v1/logs?after=${first.nextAfter}`, server.url), {
        headers: await authHeaders(),
      })
    ).json()) as {
      entries: Array<{ process: string; message: string }>;
      nextAfter?: number;
    };
    expect(
      resumed.entries
        .filter((entry) => entry.process === "renderer")
        .map((entry) => entry.message),
    ).toEqual(["three"]);
    expect(resumed.nextAfter).toBe((first.nextAfter ?? 0) + 1);
  });

  it("keeps the log routes behind the capability boundary", async () => {
    const paths = PatchdeskPaths.forTest(
      await mkdtemp(join(tmpdir(), "patchdesk-logs-auth-")),
    );
    const startup = await startLocalApiServer({
      capability,
      allowedOrigin,
      paths,
    });
    if (startup._tag !== "started")
      throw new Error("Expected local API startup");
    localApi = startup.server;

    const missing = await fetch(new URL("v1/logs", localApi.url));
    expect(missing.status).toBe(401);
    const wrongOrigin = await fetch(new URL("v1/logs", localApi.url), {
      headers: {
        Origin: "http://evil.invalid",
        "X-Patchdesk-Capability": capability,
      },
    });
    expect(wrongOrigin.status).toBe(403);
  });

  it("logs every authenticated request with status, duration, and correlation id", async () => {
    const paths = PatchdeskPaths.forTest(
      await mkdtemp(join(tmpdir(), "patchdesk-logs-http-")),
    );
    const logs = new AppLogService(paths);
    const startup = await startLocalApiServer({
      capability,
      allowedOrigin,
      paths,
      logs,
    });
    if (startup._tag !== "started")
      throw new Error("Expected local API startup");
    localApi = startup.server;

    await fetch(new URL("v1/profiles", localApi.url), {
      headers: await authHeaders("corr-123"),
    });
    const tailed = await fetch(new URL("v1/logs", localApi.url), {
      headers: await authHeaders(),
    });
    const body = (await tailed.json()) as {
      entries: Array<{
        topic: string;
        message: string;
        meta?: { status?: number; correlationId?: string };
      }>;
    };
    const httpEntries = body.entries.filter((entry) => entry.topic === "http");
    const profileRequest = httpEntries.find(
      (entry) => entry.message === "GET /v1/profiles",
    );
    expect(profileRequest).toBeDefined();
    expect(profileRequest?.meta?.status).toBe(200);
    expect(profileRequest?.meta?.correlationId).toBe("corr-123");
    // The log routes never log themselves.
    expect(
      httpEntries.some((entry) => entry.message.includes("/v1/logs")),
    ).toBe(false);
  });
});
