import { describe, expect, it } from "vitest";

import {
  DEFAULT_CDP_PORT,
  cdpPort,
  checkCdpReady,
} from "../../scripts/cdp-ready.mjs";

function collect() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    output: {
      stdout: (text: string) => stdout.push(text),
      stderr: (text: string) => stderr.push(text),
    },
  };
}

/** What CDP's `/json/version` answers with. */
type VersionPayload = { readonly Browser?: string };

/** A `fetch` that answers `/json/version` the way a live CDP port does. */
function answering(body: VersionPayload, ok = true) {
  return async () => ({ ok, json: async () => body });
}

describe("cdpPort", () => {
  it("defaults to the maintainer's port when the variable is unset", () => {
    expect(cdpPort({})).toBe(DEFAULT_CDP_PORT);
  });

  it("follows REMOTE_DEBUGGING_PORT to a session's own port", () => {
    expect(cdpPort({ REMOTE_DEBUGGING_PORT: "9241" })).toBe(9241);
  });

  it("falls back to the default when the variable is not a port", () => {
    expect(cdpPort({ REMOTE_DEBUGGING_PORT: "" })).toBe(DEFAULT_CDP_PORT);
    expect(cdpPort({ REMOTE_DEBUGGING_PORT: "nine" })).toBe(DEFAULT_CDP_PORT);
  });
});

describe("checkCdpReady", () => {
  it("reports the browser on the other end when the port answers", async () => {
    const collected = collect();
    const exitCode = await checkCdpReady({
      port: 9233,
      fetchJson: answering({ Browser: "Chrome/140.0.0.0" }),
      output: collected.output,
    });

    expect(exitCode).toBe(0);
    expect(collected.stdout.join("")).toBe(
      "CDP 9233 ready: Chrome/140.0.0.0\n",
    );
    expect(collected.stderr).toEqual([]);
  });

  it("still reports ready when the answer names no browser", async () => {
    const collected = collect();
    const exitCode = await checkCdpReady({
      port: 9241,
      fetchJson: answering({}),
      output: collected.output,
    });

    expect(exitCode).toBe(0);
    expect(collected.stdout.join("")).toBe("CDP 9241 ready: unnamed browser\n");
  });

  it("prints the remedy, naming the port, when nothing is listening", async () => {
    const collected = collect();
    const exitCode = await checkCdpReady({
      port: 9241,
      fetchJson: async () => {
        throw new Error("connect ECONNREFUSED 127.0.0.1:9241");
      },
      output: collected.output,
    });

    expect(exitCode).toBe(1);
    expect(collected.stderr.join("")).toBe(
      "CDP 9241 down. Start the app: REMOTE_DEBUGGING_PORT=9241 pnpm dev (in herdr's dev tab).\n",
    );
    expect(collected.stdout).toEqual([]);
  });

  it("reports down when the port answers with an error status", async () => {
    const collected = collect();
    const exitCode = await checkCdpReady({
      port: 9233,
      fetchJson: answering({ Browser: "Chrome" }, false),
      output: collected.output,
    });

    expect(exitCode).toBe(1);
    expect(collected.stderr.join("")).toContain("CDP 9233 down.");
  });
});
