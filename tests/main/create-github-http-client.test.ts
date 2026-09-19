import { describe, expect, it } from "vitest";

import type { LogEntryInput } from "../../src/domain/log-entry";
import { createGitHubHttpClient } from "../../src/main/local-api-stores";
import { profile } from "../adapters/github-http-fixture-server";
import { StubCredentials } from "../adapters/stub-github-credentials";

/**
 * The one transport a launch builds (ADR 0046, issue #276). A request served
 * here spawns no child, so the `github-http` log entry is what keeps it
 * countable in `scripts/gh-spawn-report.mjs`; it carries the normalized label
 * and nothing else the URL held.
 */

function recordingLogs() {
  const entries: Array<LogEntryInput> = [];
  return {
    entries,
    write: (entry: LogEntryInput): void => {
      entries.push(entry);
    },
  };
}

describe("createGitHubHttpClient", () => {
  it("serves a request through the injected fetch rather than the runtime's own", async () => {
    const urls: Array<string> = [];
    const logs = recordingLogs();
    const client = createGitHubHttpClient(
      new StubCredentials(),
      logs,
      (url) => {
        urls.push(url);
        return Promise.resolve(new Response("[]", { status: 200 }));
      },
    );

    await client.rest(profile, {
      kind: "rest",
      host: "github.com",
      path: "repos/octo-org/patchdesk/pulls?state=open",
    });

    expect(urls).toEqual([
      "https://api.github.com/repos/octo-org/patchdesk/pulls?state=open",
    ]);
  });

  it("logs one github-http entry per request, carrying no URL", async () => {
    const logs = recordingLogs();
    const client = createGitHubHttpClient(new StubCredentials(), logs, () =>
      Promise.resolve(new Response("{}", { status: 404 })),
    );

    await client.rest(profile, {
      kind: "rest",
      host: "github.com",
      path: "repos/octo-org/patchdesk/branches/main/protection",
    });

    expect(logs.entries).toHaveLength(1);
    expect(logs.entries[0]).toMatchObject({
      process: "main",
      level: "debug",
      topic: "github-http",
      message: "api GET repos/:owner/:repo/branches/:branch/protection",
      meta: {
        label: "api GET repos/:owner/:repo/branches/:branch/protection",
        status: 404,
      },
    });
    expect(JSON.stringify(logs.entries[0])).not.toContain("octo-org");
  });
});
