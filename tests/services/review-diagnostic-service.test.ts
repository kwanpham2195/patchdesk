import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { PatchdeskPaths } from "../../src/adapters/storage/patchdesk-paths";
import { parseIsoTimestamp } from "../../src/domain/ids";
import { ReviewDiagnosticService } from "../../src/services/review-diagnostic-service";

const profileId = "cfw" as never;
const sessionId = "github.com__centraldigital__patchdesk__pr-42__sha-22222222__000000000000" as never;
const at = parseIsoTimestamp("2026-07-18T00:00:00.000Z");

function must<T>(result: { readonly _tag: "ok"; readonly value: T } | { readonly _tag: "err" }): T {
  if (result._tag === "err") throw new Error("invalid fixture");
  return result.value;
}

describe("ReviewDiagnosticService", () => {
  it("persists bounded redacted events with an incident ID", async () => {
    const root = await mkdtemp(join(tmpdir(), "patchdesk-diagnostics-"));
    try {
      const paths = PatchdeskPaths.forTest(root);
      const service = new ReviewDiagnosticService(paths, () => must(at), () => "incident-001", { maxEvents: 2 });

      const recorded = await service.record({
        profileId,
        sessionId,
        category: "cleanup",
        phase: "remove-session",
        retryable: true,
        detail: "failed at /Users/matthew/.local/share/patchdesk with Bearer secret-token and a full diff @@ -1 +1 @@",
      });

      expect(recorded).toMatchObject({
        _tag: "ok",
        value: {
          incidentId: "incident-001",
          category: "cleanup",
          phase: "remove-session",
          retryable: true,
        },
      });
      if (recorded._tag === "err") return;
      expect(recorded.value.detail).not.toContain("/Users/");
      expect(recorded.value.detail).not.toContain("Bearer");
      expect(recorded.value.detail).not.toContain("@@ -1 +1 @@");

      const stored = await readFile(join(paths.profileReviewsDirectory(profileId), "diagnostics.jsonl"), "utf8");
      expect(stored.split("\n").filter(Boolean)).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails closed for paths, diffs, credentials, PR text, and stack details", async () => {
    const root = await mkdtemp(join(tmpdir(), "patchdesk-diagnostics-"));
    try {
      const paths = PatchdeskPaths.forTest(root);
      const service = new ReviewDiagnosticService(paths, () => must(at), () => "incident-unsafe");
      const recorded = await service.record({
        profileId,
        sessionId,
        category: "recovery",
        phase: "boundary",
        retryable: true,
        detail: [
          "/opt/app /var/log /Users/name C:\\\\work\\\\repo",
          "diff --git a/src/a.ts b/src/a.ts",
          "--- a/src/a.ts +++ b/src/a.ts @@ -1 +1 @@",
          "PR title: untrusted maintainer prose",
          "api_key=secret-value Authorization: Basic dXNlcjpwYXNz Bearer token-value password=hunter2",
          "Error: raw failure\n    at /opt/app/index.ts:4:2",
        ].join(" "),
      });
      expect(recorded._tag).toBe("ok");
      if (recorded._tag === "err") return;
      expect(recorded.value.detail).toBe("[redacted diagnostic detail]");
      const bundle = await service.exportSupportBundle({ profileId, sessionId });
      expect(bundle._tag).toBe("ok");
      if (bundle._tag === "err") return;
      const serialized = JSON.stringify(bundle.value);
      for (const forbidden of ["/opt/app", "/var/log", "C:\\\\work", "diff --git", "--- a/", "+++ b/", "PR title", "secret-value", "dXNlcjpwYXNz", "Bearer", "hunter2", "Error: raw failure", "at /opt"]) {
        expect(serialized).not.toContain(forbidden);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("serializes concurrent writes and bounds oversized existing files", async () => {
    const root = await mkdtemp(join(tmpdir(), "patchdesk-diagnostics-"));
    try {
      const paths = PatchdeskPaths.forTest(root);
      const service = new ReviewDiagnosticService(paths, () => must(at), () => `incident-${Math.random()}`, { maxEvents: 10_000 });
      const file = join(paths.profileReviewsDirectory(profileId), "diagnostics.jsonl");
      await mkdir(paths.profileReviewsDirectory(profileId), { recursive: true });
      await writeFile(file, `${"not-json\n".repeat(500_000)}${JSON.stringify({ schemaVersion: 1, incidentId: "old", at: "2026-07-18T00:00:00.000Z", category: "run", phase: "old", profileId, retryable: false })}\n`, "utf8");

      const results = await Promise.all(Array.from({ length: 25 }, (_, index) => service.record({
        profileId,
        category: "run",
        phase: `concurrent-${index}`,
        retryable: true,
        detail: `safe failure ${index}`,
      })));
      expect(results.every((result) => result._tag === "ok")).toBe(true);
      const recent = await service.recent(profileId);
      expect(recent._tag).toBe("ok");
      if (recent._tag === "err") return;
      expect(recent.value).toHaveLength(26);
      expect(recent.value.length).toBeLessThanOrEqual(200);
      expect((await readFile(file, "utf8")).length).toBeLessThan(200_000);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("redacts contextual paths, standalone credentials, and typed stack headers", async () => {
    const root = await mkdtemp(join(tmpdir(), "patchdesk-diagnostics-"));
    try {
      const paths = PatchdeskPaths.forTest(root);
      const service = new ReviewDiagnosticService(paths, () => must(at), () => "incident-context");
      const unsafeDetails = [
        "path=/opt/app/index.ts",
        "file:/private/repo/index.ts",
        "(/Users/name/repo)",
        "Bearer abc123",
        "Basic dXNlcjpwYXNz",
        "token abc123",
        "password hunter2",
        "api_key=secret",
        "Authorization Bearer abc123",
        "TypeError: Cannot read property",
        "RangeError: invalid range",
      ];
      for (const detail of unsafeDetails) {
        const result = await service.record({ profileId, category: "recovery", phase: "boundary", retryable: true, detail });
        expect(result).toMatchObject({ _tag: "ok", value: { detail: "[redacted diagnostic detail]" } });
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("re-sanitizes unsafe historical events before support export", async () => {
    const root = await mkdtemp(join(tmpdir(), "patchdesk-diagnostics-"));
    try {
      const paths = PatchdeskPaths.forTest(root);
      const file = join(paths.profileReviewsDirectory(profileId), "diagnostics.jsonl");
      await mkdir(paths.profileReviewsDirectory(profileId), { recursive: true });
      await writeFile(file, `${JSON.stringify({
        schemaVersion: 1,
        incidentId: "incident-historical",
        at: "2026-07-18T00:00:00.000Z",
        category: "recovery",
        phase: "path=/opt/app",
        profileId,
        retryable: true,
        detail: "path=/opt/app TypeError: secret Bearer abc123",
      })}\n`, "utf8");
      const service = new ReviewDiagnosticService(paths, () => must(at));
      const bundle = await service.exportSupportBundle({ profileId });
      expect(bundle).toMatchObject({ _tag: "ok", value: { events: [{ incidentId: "incident-historical", detail: "[redacted diagnostic detail]" }] } });
      if (bundle._tag === "ok") {
        const serialized = JSON.stringify(bundle.value);
        expect(serialized).not.toContain("/opt/app");
        expect(serialized).not.toContain("TypeError");
        expect(serialized).not.toContain("Bearer");
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("serializes writes across independent service instances", async () => {
    const root = await mkdtemp(join(tmpdir(), "patchdesk-diagnostics-"));
    try {
      const paths = PatchdeskPaths.forTest(root);
      const first = new ReviewDiagnosticService(paths, () => must(at), () => "incident-first");
      const second = new ReviewDiagnosticService(paths, () => must(at), () => "incident-second");
      const results = await Promise.all([
        first.record({ profileId, category: "run", phase: "first", retryable: true }),
        second.record({ profileId, category: "run", phase: "second", retryable: true }),
      ]);
      expect(results.every((result) => result._tag === "ok")).toBe(true);
      const recent = await first.recent(profileId);
      expect(recent).toMatchObject({ _tag: "ok", value: expect.arrayContaining([
        expect.objectContaining({ phase: "first" }),
        expect.objectContaining({ phase: "second" }),
      ]) });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps only the bounded recent event window and exports sanitized support data", async () => {
    const root = await mkdtemp(join(tmpdir(), "patchdesk-diagnostics-"));
    try {
      const paths = PatchdeskPaths.forTest(root);
      let sequence = 0;
      const service = new ReviewDiagnosticService(
        paths,
        () => must(at),
        () => `incident-${++sequence}`,
        { maxEvents: 2, maxDetailLength: 80 },
      );

      await service.record({ profileId, sessionId, category: "run", phase: "first", retryable: false, detail: "first" });
      await service.record({ profileId, sessionId, category: "run", phase: "second", retryable: true, detail: "second" });
      await service.record({
        profileId,
        sessionId,
        category: "recovery",
        phase: "third",
        retryable: true,
        detail: "Error: raw stack at /private/repo\n at doThing() with token=top-secret",
      });

      const bundle = await service.exportSupportBundle({
        profileId,
        sessionId,
        metadata: {
          title: "Untrusted PR title\nwith /private/repo and token=top-secret",
        },
      });

      expect(bundle._tag).toBe("ok");
      if (bundle._tag === "err") return;
      expect(bundle.value.events).toHaveLength(2);
      expect(bundle.value.events.map((event) => event.incidentId)).toEqual(["incident-2", "incident-3"]);
      const serialized = JSON.stringify(bundle.value);
      expect(serialized).not.toContain("/private/repo");
      expect(serialized).not.toContain("top-secret");
      expect(serialized).not.toContain("raw stack");
      expect(serialized).toContain("incident-3");
      expect(bundle.value.metadata?.title).not.toContain("token=");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
