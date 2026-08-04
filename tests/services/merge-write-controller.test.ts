import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { PatchdeskPaths } from "../../src/adapters/storage/patchdesk-paths";
import { MergeOperationStore } from "../../src/adapters/storage/merge-operation-store";
import { ProfileStore } from "../../src/adapters/storage/profile-store";
import { ReviewSessionStore } from "../../src/adapters/storage/review-session-store";
import { parseAbsolutePath, parseGitHubHost, parseGitHubOwner, parseGitHubRepoName, parseGitSha, parseIsoTimestamp, parsePullRequestNumber, parseWorkspaceProfileId } from "../../src/domain/ids";
import { createReviewSession } from "../../src/domain/review-session";
import { parseWorkspaceProfileConfig } from "../../src/domain/workspace-profile";
import { err, ok } from "../../src/domain/result";
import { MergeWriteController } from "../../src/services/merge-write-controller";

const roots: string[] = [];
const now = must(parseIsoTimestamp("2026-08-01T00:00:00.000Z"));

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("MergeWriteController", () => {
  it("rejects malformed requests before loading or writing", async () => {
    const fixture = await mergeFixture();

    await expect(fixture.controller.merge({ profileId: fixture.profileId, sessionId: fixture.session.id, method: "delete", acknowledgedWarnings: true })).resolves.toEqual({ _tag: "err", error: { reason: "invalid_input" } });
    await expect(fixture.sessions.load(fixture.profileId, fixture.session.id)).resolves.toMatchObject({ _tag: "ok", value: { state: { _tag: "Created" } } });
  });

  it("delegates the valid merge once and persists its merged session", async () => {
    const fixture = await mergeFixture();

    await expect(fixture.controller.merge(fixture.request)).resolves.toMatchObject({ _tag: "ok", value: { session: { state: { _tag: "Merged" } } } });
    expect(fixture.mergeRequests).toEqual([{ method: "squash", headSha: fixture.session.key.headSha }]);
    await expect(fixture.sessions.load(fixture.profileId, fixture.session.id)).resolves.toMatchObject({ _tag: "ok", value: { state: { _tag: "Merged" } } });
  });

  it("forwards warning acknowledgement unchanged", async () => {
    const fixture = await mergeFixture({ acknowledgedWarnings: false });

    await expect(fixture.controller.merge(fixture.request)).resolves.toMatchObject({ _tag: "ok" });
    expect(fixture.mergeRequests).toEqual([{ method: "squash", headSha: fixture.session.key.headSha }]);
  });

  it("does not save when the merge domain operation fails", async () => {
    const fixture = await mergeFixture({ mergeResult: err({ _tag: "GitHubWriteFailure" as const, category: "unavailable" as const, message: "Fixture unavailable." }) });

    await expect(fixture.controller.merge(fixture.request)).resolves.toEqual({ _tag: "err", error: { reason: "merge_failed" } });
    await expect(fixture.sessions.load(fixture.profileId, fixture.session.id)).resolves.toMatchObject({ _tag: "ok", value: { state: { _tag: "Created" } } });
  });

  it("reports storage failure after the remote merge succeeds", async () => {
    const fixture = await mergeFixture({ breakSave: true });

    await expect(fixture.controller.merge(fixture.request)).resolves.toEqual({ _tag: "err", error: { reason: "merge_outcome_unknown" } });
    expect(fixture.mergeRequests).toEqual([{ method: "squash", headSha: fixture.session.key.headSha }]);
  });

  it("rejects a concurrent merge before it can issue a second remote write", async () => {
    let resolve: ((value: ReturnType<typeof ok<{ readonly mergeCommitSha?: never }>>) => void) | undefined;
    const pending = new Promise<ReturnType<typeof ok<{ readonly mergeCommitSha?: never }>>>((next) => { resolve = next; });
    const fixture = await mergeFixture({ mergeResult: pending });
    const first = fixture.controller.merge(fixture.request);
    await vi.waitFor(() => expect(fixture.mergeRequests).toHaveLength(1));
    await expect(fixture.controller.merge(fixture.request)).resolves.toEqual({ _tag: "err", error: { reason: "merge_in_progress" } });
    resolve?.(ok({}));
    await expect(first).resolves.toMatchObject({ _tag: "ok" });
    expect(fixture.mergeRequests).toHaveLength(1);
  });
});

type MergeGatewayResult =
  | { readonly _tag: "ok"; readonly value: { readonly mergeCommitSha?: never } }
  | { readonly _tag: "err"; readonly error: { readonly _tag: "GitHubWriteFailure"; readonly category: "unavailable"; readonly message: string } };

async function mergeFixture(options: { readonly acknowledgedWarnings?: boolean; readonly mergeResult?: MergeGatewayResult | Promise<MergeGatewayResult>; readonly breakSave?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "patchdesk-merge-write-"));
  roots.push(root);
  const paths = PatchdeskPaths.forTest(root);
  const profileId = must(parseWorkspaceProfileId("cfw"));
  const profile = must(parseWorkspaceProfileConfig({ id: profileId, label: "CFW", githubHost: "github.com", ghAccount: "fixture", ownerFilters: [], workspaceRoots: [], rulePaths: [], repos: [] }));
  const key = { profileId, host: must(parseGitHubHost("github.com")), owner: must(parseGitHubOwner("centraldigital")), repo: must(parseGitHubRepoName("patchdesk")), prNumber: must(parsePullRequestNumber(42)), headSha: must(parseGitSha("abcdef1234567890abcdef1234567890abcdef12")) };
  const seeded = createReviewSession({ key, pr: { headSha: key.headSha, isDraft: false, isOpen: true }, patchPath: must(parseAbsolutePath(paths.patchFile(profileId, "placeholder" as never))), worktree: { path: must(parseAbsolutePath(paths.worktreeDirectory(profileId, "placeholder" as never))), headSha: key.headSha }, createdAt: now });
  const session = { ...seeded, patchPath: must(parseAbsolutePath(paths.patchFile(profileId, seeded.id))), worktree: { path: must(parseAbsolutePath(paths.worktreeDirectory(profileId, seeded.id))), headSha: key.headSha } };
  const profiles = new ProfileStore(paths);
  const sessions = new ReviewSessionStore(paths);
  await profiles.save(profile);
  await sessions.save(session);
  const mergeRequests: Array<{ readonly method: string; readonly headSha: string }> = [];
  const gateway = {
    async getMergePolicy() { return ok({ pr: { host: key.host, owner: key.owner, repo: key.repo, number: key.prNumber }, headSha: key.headSha, isOpen: true, isDraft: false, mergeability: "mergeable" as const, reviewDecision: "approved" as const, checks: { overall: "passing" as const, checks: [] }, complete: true }); },
    async mergePullRequest(input: { readonly method: string; readonly headSha: string }) { mergeRequests.push({ method: input.method, headSha: input.headSha }); if (options.breakSave === true) { await rm(paths.sessionFile(profileId, session.id)); await mkdir(paths.sessionFile(profileId, session.id), { recursive: true }); } return await (options.mergeResult ?? ok({})); },
  };
  const gate = {
    async requireFresh(_profileId: unknown, _reviewId: unknown, expected: { readonly sessionId: unknown; readonly headSha: unknown }) {
      return ok({ profile, review: {} as never, session: { ...session, id: expected.sessionId, key: { ...session.key, headSha: expected.headSha } } as never, snapshot: {} as never });
    },
  } as never;
  const controller = new MergeWriteController(profiles, sessions, gateway, ["squash"], () => now, new MergeOperationStore(paths), gate);
  return { controller, sessions, profileId, session, mergeRequests, request: { profileId, reviewId: "github.com__centraldigital__patchdesk__pr-42__review-aaaaaaaaaaaa", sessionId: session.id, expectedHeadSha: session.key.headSha, expectedPatchHash: "a".repeat(64), expectedRevision: now, method: "squash", acknowledgedWarnings: options.acknowledgedWarnings ?? true } };
}

function must<T>(result: { readonly _tag: "ok"; readonly value: T } | { readonly _tag: "err" }): T { if (result._tag === "err") throw new Error("Invalid fixture"); return result.value; }
