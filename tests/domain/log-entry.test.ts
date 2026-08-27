import { describe, expect, it } from "vitest";

import {
  loggableMetaValue,
  maskLogSecrets,
  normalizeLogEntry,
  parseLogEntry,
  sanitizeLogMeta,
} from "../../src/domain/log-entry";

/** The exact shape `electron-main.ts`'s two crash handlers write. */
function crashEntry(cause: unknown) {
  return normalizeLogEntry({
    seq: 1,
    at: "2026-08-08T00:00:00.000Z",
    process: "main",
    level: "error",
    topic: "crash",
    message: "Uncaught main-process exception",
    meta: { error: loggableMetaValue(cause) },
  });
}

describe("log entry redaction", () => {
  it("masks credential shapes inline while keeping the rest of the line", () => {
    expect(maskLogSecrets("auth with ghp_1234567890abcdef for repo")).toBe(
      "auth with [redacted] for repo",
    );
    expect(maskLogSecrets("Bearer eyJhbGciOiJIUzI1NiJ9 payload")).toBe(
      "Bearer [redacted] payload",
    );
    expect(maskLogSecrets("token=supersecret123 rest")).toContain("[redacted]");
    expect(maskLogSecrets("token=supersecret123 rest")).toContain("rest");
  });

  it("keeps paths and error text intact (local debug log)", () => {
    const masked = maskLogSecrets(
      "failed at /Users/matthew/.local/share/patchdesk: ENOENT",
    );
    expect(masked).toContain("/Users/matthew");
    expect(masked).toContain("ENOENT");
  });

  it("drops sensitive meta keys entirely", () => {
    const meta = sanitizeLogMeta({
      authorization: "Bearer secret",
      apiKey: "k-123",
      password: "hunter2",
      token: "t-1",
      profileId: "cfw",
      status: 500,
      path: "/tmp/workspace",
    });
    expect(meta).toEqual({
      profileId: "cfw",
      status: 500,
      path: "/tmp/workspace",
    });
  });

  it("masks secret-shaped values under non-sensitive keys and truncates long strings", () => {
    const meta = sanitizeLogMeta({ url: "https://x?token=abc123&rest=ok" });
    expect(meta?.url).not.toContain("abc123");
    const long = sanitizeLogMeta({ text: "x".repeat(2_000) });
    expect(long?.text).toHaveLength(512);
  });

  it("normalizes entries with bounded topic and message", () => {
    const entry = normalizeLogEntry({
      seq: 1,
      at: "2026-08-08T00:00:00.000Z",
      process: "main",
      level: "info",
      topic: "t".repeat(200),
      message: "m".repeat(2_000),
      meta: { authorization: "Bearer x", ok: true },
    });
    expect(entry.topic).toHaveLength(48);
    expect(entry.message).toHaveLength(512);
    expect(entry.meta).toEqual({ ok: true });
  });

  it("records a normal Error with its name, message and stack", () => {
    const cause = new Error("boom");
    expect(crashEntry(cause).meta).toMatchObject({
      error: { name: "Error", message: "boom" },
    });
  });

  it("records a crash whose Error carries a non-string name or message", () => {
    // `instanceof Error` does not make these fields strings. Anything can be
    // thrown and anything can reject a promise, so the crash handlers must
    // record such a value rather than throw while recording it.
    expect(
      crashEntry(Object.assign(new Error("boom"), { name: 42 })).meta,
    ).toMatchObject({ error: { name: 42, message: "boom" } });

    const objectMessage = Object.assign(new Error("boom"), { message: {} });
    expect(crashEntry(objectMessage).meta).toMatchObject({
      error: { name: "Error" },
    });

    const nullMessage = Object.assign(new Error("boom"), { message: null });
    expect(crashEntry(nullMessage).meta).toMatchObject({
      error: { name: "Error", message: null },
    });

    const rejection: unknown = Object.assign(Object.create(Error.prototype), {
      message: { detail: "structured" },
    });
    expect(crashEntry(rejection).meta).toMatchObject({
      error: { name: "Error", message: { detail: "structured" } },
    });
  });

  it("records a crash whose Error carries a non-string stack", () => {
    expect(
      crashEntry(Object.assign(new Error("boom"), { stack: 7 })).meta,
    ).toMatchObject({ error: { name: "Error", message: "boom", stack: 7 } });
  });

  it("bounds an Error stack to a thousand characters before masking it", () => {
    const cause = Object.assign(new Error("boom"), {
      stack: `${"s".repeat(2_000)} ghp_1234567890abcdef`,
    });
    const meta = crashEntry(cause).meta;
    expect(meta).toMatchObject({ error: { stack: "s".repeat(512) } });
    expect(JSON.stringify(meta)).not.toContain("ghp_");
  });

  it("parses persisted entries and rejects malformed ones", () => {
    const entry = normalizeLogEntry({
      seq: 2,
      at: "2026-08-08T00:00:00.000Z",
      process: "renderer",
      level: "warn",
      topic: "api",
      message: "POST /v1/removed-review-command failed",
    });
    expect(parseLogEntry(structuredClone(entry))).toMatchObject({
      seq: 2,
      process: "renderer",
    });
    expect(parseLogEntry({ seq: "not-a-number" })).toBeUndefined();
    expect(parseLogEntry({ ...entry, level: "verbose" })).toBeUndefined();
  });
});
