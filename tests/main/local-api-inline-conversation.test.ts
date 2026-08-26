import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PatchdeskPaths } from "../../src/adapters/storage/patchdesk-paths";
import type { LogEntryInput } from "../../src/domain/log-entry";
import {
  startLocalApiServer,
  type LocalApiServer,
} from "../../src/main/local-api";

const capability = "test-capability";
const origin = "http://patchdesk.test";
const sentinel = "SENTINEL-DO-NOT-LOG-9f3d2c";
let server: LocalApiServer | undefined;
let root: string | undefined;

afterEach(async () => {
  await server?.stop();
  server = undefined;
  if (root !== undefined) await rm(root, { recursive: true, force: true });
  root = undefined;
  vi.restoreAllMocks();
});

// Recursively searches every value reachable from `value` (arrays, plain
// objects, and their nested fields) for `needle`. A shallow check on
// `message` alone would miss a leak placed in `meta`, which is exactly where
// the regression this guards against put it. `value` stays `unknown`: it
// walks an arbitrary, already-captured `logs.write` call argument, which has
// no single named domain type to narrow it to.
function containsString(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- see comment above
  value: unknown,
  needle: string,
  seen: Set<unknown> = new Set(),
): boolean {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- narrows an arbitrary captured log value with no earlier parser to defer to.
  if (typeof value === "string") return value.includes(needle);
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- narrows an arbitrary captured log value with no earlier parser to defer to.
  if (value === null || typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);
  const children = Array.isArray(value) ? value : Object.values(value);
  return children.some((entry) => containsString(entry, needle, seen));
}

describe("POST /v1/reviews/inline-conversations/command parse failures", () => {
  it("never calls console.error and never leaks the raw command body into a logs.write call", async () => {
    root = await mkdtemp(join(tmpdir(), "patchdesk-inline-conversation-"));
    const writes: LogEntryInput[] = [];
    const logs = {
      write: vi.fn((entry: LogEntryInput) => {
        writes.push(entry);
      }),
      tail: () => ({ entries: [] }),
    };
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});

    const started = await startLocalApiServer({
      capability,
      allowedOrigin: origin,
      paths: PatchdeskPaths.forTest(root),
      logs,
    });
    if (started._tag !== "started") throw new Error("local API did not start");
    server = started.server;

    const response = await fetch(
      new URL("v1/reviews/inline-conversations/command", server.url),
      {
        method: "POST",
        headers: {
          Origin: origin,
          "X-Patchdesk-Capability": capability,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          profileId: "profile",
          reviewId:
            "github.com__centraldigital__patchdesk__pr-42__review-abcdef123456",
          command: {
            // `_tag` must be a string; sending a number is what drives this
            // request into the parse-failure branch under test.
            _tag: 42,
            expected: {},
            secretField: sentinel,
          },
        }),
      },
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "invalid_input" });
    expect(consoleError).not.toHaveBeenCalled();
    expect(containsString(writes, sentinel)).toBe(false);
  });
});
