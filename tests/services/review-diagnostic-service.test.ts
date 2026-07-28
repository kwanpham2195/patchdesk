import { mkdtemp, readFile, rm } from "node:fs/promises";
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
