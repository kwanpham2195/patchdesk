import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it } from "vitest";

import { FakeGitHubAdapter } from "../../src/adapters/github/github-adapter";
import { PatchdeskPaths } from "../../src/adapters/storage/patchdesk-paths";
import type { AccountInsightProvider } from "../../src/domain/insight-provider";
import { err, ok } from "../../src/domain/result";
import {
  startLocalApiServer,
  type LocalApiServer,
} from "../../src/main/local-api";

const capability = "cap";
const origin = "http://patchdesk.test";
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

it("activates each account provider on its own route and names the pi version an outdated pi needs", async () => {
  root = await mkdtemp(join(tmpdir(), "patchdesk-provider-routes-"));
  const activated: Array<AccountInsightProvider> = [];
  const started = await startLocalApiServer({
    allowedOrigin: origin,
    capability,
    paths: PatchdeskPaths.forTest(root),
    github: new FakeGitHubAdapter({}),
    insightProviders: {
      async passive() {
        return ok({ providers: [], models: [] });
      },
      async activateAccount(provider) {
        activated.push(provider);
        return provider === "pi-cli-account"
          ? err({
              _tag: "InsightProviderCatalogUnavailable",
              reason: "runtime_unavailable",
              requiredVersion: "0.80.4",
            })
          : ok({ providers: [], models: [] });
      },
    },
  });
  if (started._tag !== "started") throw new Error("local API did not start");
  server = started.server;

  const codex = await post("v1/insight-providers/codex/models");
  expect(codex.status).toBe(200);
  const pi = await post("v1/insight-providers/pi-cli/models");
  expect(pi.status).toBe(503);
  expect(await pi.json()).toEqual({
    error: "runtime_unavailable",
    requiredVersion: "0.80.4",
  });
  expect(activated).toEqual(["codex-cli-account", "pi-cli-account"]);
});

async function post(path: string): Promise<Response> {
  if (server === undefined) throw new Error("server not started");
  return await fetch(new URL(path, server.url), {
    method: "POST",
    headers: {
      Origin: origin,
      "Content-Type": "application/json",
      "X-Patchdesk-Capability": capability,
    },
    body: "{}",
  });
}
