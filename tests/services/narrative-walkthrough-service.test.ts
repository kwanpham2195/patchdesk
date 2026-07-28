import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

import { PatchdeskPaths } from "../../src/adapters/storage/patchdesk-paths";
import { createReviewSession } from "../../src/domain/review-session";
import { parseAbsolutePath, parseGitHubHost, parseGitHubOwner, parseGitHubRepoName, parseGitSha, parseIsoTimestamp, parsePullRequestNumber, parseReviewSessionId, parseWorkspaceProfileId } from "../../src/domain/ids";
import { NarrativeWalkthroughService, type NarrativeWalkthroughInvoker } from "../../src/services/narrative-walkthrough-service";
import { ok, err } from "../../src/domain/result";

function unwrap<T>(result: { readonly _tag: "ok"; readonly value: T } | { readonly _tag: "err" }): T {
  if (result._tag === "err") throw new Error("fixture parse failed");
  return result.value;
}

const profileId = unwrap(parseWorkspaceProfileId("profile"));
const headSha = unwrap(parseGitSha("abcdef1234567890abcdef1234567890abcdef12"));
const baseSha = unwrap(parseGitSha("fedcba9876543210fedcba9876543210fedcba98"));
const patch = [
  "diff --git a/src/example.ts b/src/example.ts",
  "index 1111111..2222222 100644",
  "--- a/src/example.ts",
  "+++ b/src/example.ts",
  "@@ -1,1 +1,1 @@",
  "-before",
  "+after",
  "",
].join("\n");

function fixtureSession(patchPath: Parameters<typeof createReviewSession>[0]["patchPath"], completed = true) {
  const session = createReviewSession({
    key: {
      profileId,
      host: unwrap(parseGitHubHost("github.com")),
      owner: unwrap(parseGitHubOwner("centraldigital")),
      repo: unwrap(parseGitHubRepoName("patchdesk")),
      prNumber: unwrap(parsePullRequestNumber(42)),
      headSha,
    },
    pr: { headSha, baseSha, isDraft: false, isOpen: true },
    patchPath,
    worktree: { path: patchPath, headSha },
    createdAt: unwrap(parseIsoTimestamp("2026-07-27T00:00:00.000Z")),
  });
  return completed ? { ...session, state: { _tag: "ReviewCompleted" as const, attemptId: "001" as never }, currentAttemptId: "001" as never } : session;
}

function output() {
  return { title: "A change", focus: "It changes behavior", chapters: [{ title: "Behavior", sections: [{ title: "Update", prose: "The implementation changes the result.", hunkIds: ["h1"] }] }] };
}

async function serviceFixture(invoker: NarrativeWalkthroughInvoker, completed = true) {
  const root = await mkdtemp(join(tmpdir(), "patchdesk-walkthrough-service-"));
  const paths = PatchdeskPaths.forTest(root);
  const patchPath = unwrap(parseAbsolutePath(paths.patchFile(profileId, "session" as never)));
  await mkdir(dirname(patchPath), { recursive: true });
  await writeFile(patchPath, patch);
  const session = fixtureSession(patchPath, completed);
  const sessions = { async load() { return ok(session); } };
  const profiles = { async load() { return ok({} as never); } };
  const diagnostics = { async record() { return ok({ incidentId: "incident-safe" } as never); } };
  const service = new NarrativeWalkthroughService(profiles, sessions, paths, invoker, diagnostics);
  return { service, sessionId: session.id, patchPath };
}

describe("NarrativeWalkthroughService", () => {
  it("publishes only the latest generation when an earlier result completes late", async () => {
    let releaseFirst!: (value: ReturnType<typeof ok>) => void;
    let call = 0;
    const invoker: NarrativeWalkthroughInvoker = { invoke: async () => {
      call += 1;
      if (call === 1) return await new Promise((resolve) => { releaseFirst = resolve; });
      return ok(output());
    } };
    const { service, sessionId } = await serviceFixture(invoker);
    const first = service.generate({ profileId, sessionId, model: "model", reasoning: "medium" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const second = await service.generate({ profileId, sessionId, model: "model", reasoning: "medium" });
    expect(second._tag).toBe("ok");
    expect(second._tag === "ok" ? second.value.lifecycle : "").toBe("ready");
    releaseFirst(ok(output()));
    const late = await first;
    expect(late._tag).toBe("ok");
    expect(late._tag === "ok" ? late.value.lifecycle : "").toBe("stale");
  });

  it("returns failed with an incident and allows a retry", async () => {
    let attempts = 0;
    const invoker: NarrativeWalkthroughInvoker = { invoke: async () => {
      attempts += 1;
      return attempts === 1 ? err({ reason: "execution_failed" }) : ok(output());
    } };
    const { service, sessionId } = await serviceFixture(invoker);
    const failed = await service.generate({ profileId, sessionId, model: "model", reasoning: "low" });
    expect(failed._tag === "ok" ? failed.value.lifecycle : "").toBe("failed");
    expect(failed._tag === "ok" ? failed.value.incidentId : undefined).toBe("incident-safe");
    const retry = await service.generate({ profileId, sessionId, model: "model", reasoning: "low" });
    expect(retry._tag === "ok" ? retry.value.lifecycle : "").toBe("ready");
  });

  it("rejects invalid model output without exposing raw details", async () => {
    const { service, sessionId } = await serviceFixture({ invoke: async () => ok({ invalid: true }) });
    const result = await service.generate({ profileId, sessionId, model: "model", reasoning: "high" });
    expect(result._tag === "ok" ? result.value.lifecycle : "").toBe("failed");
    expect(result._tag === "ok" ? result.value.noticeKey : "").toBe("walkthrough-failed");
  });

  it("suppresses publication when the patch changes during generation", async () => {
    let release!: () => void;
    const invoker: NarrativeWalkthroughInvoker = { invoke: async () => { await new Promise<void>((resolve) => { release = resolve; }); return ok(output()); } };
    const { service, sessionId, patchPath } = await serviceFixture(invoker);
    const pending = service.generate({ profileId, sessionId, model: "model", reasoning: "medium" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await writeFile(patchPath, `${patch}\n+changed\n`);
    release();
    const result = await pending;
    expect(result._tag === "ok" ? result.value.lifecycle : "").toBe("stale");
  });

  it("rejects non-completed snapshots", async () => {
    const { service, sessionId } = await serviceFixture({ invoke: async () => ok(output()) }, false);
    const result = await service.generate({ profileId, sessionId, model: "model", reasoning: "medium" });
    expect(result).toEqual({ _tag: "err", error: { reason: "not_completed" } });
  });

  it("keeps records isolated by profile and session", async () => {
    const { service, sessionId } = await serviceFixture({ invoke: async () => ok(output()) });
    const one = await service.generate({ profileId, sessionId, model: "model", reasoning: "medium" });
    const other = await service.load({ profileId, sessionId: unwrap(parseReviewSessionId("github.com__centraldigital__patchdesk__pr-43__sha-abcdef12__0123456789ab")), model: "model", reasoning: "medium" });
    expect(one._tag === "ok" ? one.value.lifecycle : "").toBe("ready");
    expect(other._tag).toBe("err");
  });
});
