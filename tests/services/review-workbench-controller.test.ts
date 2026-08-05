import { describe, expect, it, vi } from "vitest";

import { ReviewWorkbenchController } from "../../src/services/review-workbench-controller";
import { createReview, markReviewTerminal, type Review } from "../../src/domain/review";
import { createReviewId, createReviewSessionId, parseGitHubHost, parseGitHubOwner, parseGitHubRepoName, parseGitSha, parseIsoTimestamp, parsePullRequestNumber, parseWorkspaceProfileId } from "../../src/domain/ids";
import { ok, type Result } from "../../src/domain/result";

const must = <T>(result: Result<T, unknown>): T => {
  if (result._tag === "ok") return result.value;
  throw new Error("fixture");
};
const profileId = must(parseWorkspaceProfileId("cfw"));
const identity = { profileId, host: must(parseGitHubHost("github.com")), owner: must(parseGitHubOwner("centraldigital")), repo: must(parseGitHubRepoName("patchdesk")), prNumber: must(parsePullRequestNumber(42)) };
const firstSha = must(parseGitSha("1".repeat(40)));
const secondSha = must(parseGitSha("2".repeat(40)));
const now = must(parseIsoTimestamp("2026-08-01T00:00:00.000Z"));
const later = must(parseIsoTimestamp("2026-08-01T00:01:00.000Z"));
const firstSessionId = createReviewSessionId({ ...identity, headSha: firstSha });
const secondSessionId = createReviewSessionId({ ...identity, headSha: secondSha });
const representedRemote = { headSha: firstSha, pullRequestUpdatedAt: now, snapshotHash: "a".repeat(64) as never, refreshedAt: now };

function projection(): never { return { state: "review" } as never; }
function controller(options: { readonly existing?: Review; readonly preparedSessionId?: typeof firstSessionId; readonly preparedHead?: typeof firstSha; readonly prepareCalls?: ReturnType<typeof vi.fn>; readonly save?: ReturnType<typeof vi.fn>; readonly loadLocal?: ReturnType<typeof vi.fn>; readonly loadRepresented?: ReturnType<typeof vi.fn>; readonly load?: ReturnType<typeof vi.fn>; readonly commits?: unknown; readonly refresh?: { readonly refresh: ReturnType<typeof vi.fn> }; readonly migration?: { migrateProfile: ReturnType<typeof vi.fn> }; readonly lifecycle?: boolean }) {
  const prepareCalls = options.prepareCalls ?? vi.fn();
  let storedReview = options.existing;
  const save = options.save ?? vi.fn(async (value: Review) => { storedReview = value; return ok(undefined); });
  const prep = { async prepare(input: unknown) { prepareCalls(input); return ok({ disposition: "resumed", session: { id: options.preparedSessionId ?? firstSessionId, key: { ...identity, headSha: options.preparedHead ?? firstSha }, updatedAt: later } } as never); } };
  const reviews = { async load() { return storedReview === undefined ? ({ _tag: "err", error: { _tag: "StorageFailure", operation: "read", reason: "not_found" } } as never) : ok(storedReview); }, save };
  const remote = { async load() { return ok({} as never); } };
  const loadLocal = options.loadLocal ?? vi.fn(async () => ok(projection()));
  const loadRepresented = options.loadRepresented ?? vi.fn(async () => ok(projection()));
  const load = options.load ?? vi.fn(async () => ok(projection()));
  const projectionService = { load, loadLocal, loadRepresented };
  const value = new ReviewWorkbenchController(prep as never, projectionService as never, options.lifecycle === false ? undefined : { reviews, remote, refresh: options.refresh ?? {}, ...(options.commits === undefined ? {} : { commits: options.commits }), ...(options.migration === undefined ? {} : { migration: options.migration }) } as never);
  return { value, prepareCalls, save };
}

function review(): Review {
  return { ...createReview({ identity, currentSessionId: firstSessionId, headSha: firstSha, createdAt: now }), representedRemote };
}

describe("ReviewWorkbenchController stable open", () => {
  it("runs migration before a direct open can prepare or project legacy state", async () => {
    const order: string[] = [];
    const migration = { migrateProfile: vi.fn(async () => { order.push("migration"); return ok(undefined); }) };
    const prepareCalls = vi.fn(() => { order.push("prepare"); });
    const { value } = controller({ migration, prepareCalls });
    await value.open({ profileId: "cfw", host: "github.com", owner: "centraldigital", repo: "patchdesk", number: 42 });
    expect(migration.migrateProfile).toHaveBeenCalledWith(profileId);
    expect(order).toEqual(["migration", "prepare"]);
  });

  it("runs migration before loading a Review by direct identity", async () => {
    const order: string[] = [];
    const migration = { migrateProfile: vi.fn(async () => { order.push("migration"); return ok(undefined); }) };
    const load = vi.fn(async () => { order.push("load"); return ok(projection()); });
    const { value } = controller({ migration, load });
    await value.load({ profileId: "cfw", sessionId: firstSessionId });
    expect(migration.migrateProfile).toHaveBeenCalledWith(profileId);
    expect(order).toEqual(["migration", "load"]);
  });

  it("creates one stable Review on first open", async () => {
    const { value, prepareCalls, save } = controller({});
    const opened = await value.open({ profileId: "cfw", host: "github.com", owner: "centraldigital", repo: "patchdesk", number: 42 });
    expect(opened._tag).toBe("ok");
    expect(prepareCalls).toHaveBeenCalledOnce();
    expect(save).toHaveBeenCalledOnce();
  });

  it("keeps the lifecycle-free first open on the session projection path", async () => {
    const load = vi.fn(async () => ok(projection()));
    const { value, prepareCalls } = controller({ lifecycle: false, load });
    const opened = await value.open({ profileId: "cfw", host: "github.com", owner: "centraldigital", repo: "patchdesk", number: 42 });
    expect(opened).toEqual({ _tag: "ok", value: { state: "review" } });
    expect(prepareCalls).toHaveBeenCalledOnce();
    expect(load).toHaveBeenCalledWith({ profileId, sessionId: firstSessionId });
  });

  it("fetches the initial GitHub snapshot when a Review is first opened", async () => {
    const refresh = { refresh: vi.fn(async () => ok(undefined)) };
    const { value } = controller({ refresh });

    await expect(value.open({ profileId: "cfw", host: "github.com", owner: "centraldigital", repo: "patchdesk", number: 42 })).resolves.toMatchObject({ _tag: "ok" });
    expect(refresh.refresh).toHaveBeenCalledWith({ profileId, reviewId: createReviewId(identity) });
  });

  it("fetches the initial snapshot for an existing Review that has never refreshed", async () => {
    const refresh = { refresh: vi.fn(async () => ok(undefined)) };
    const unrefreshed = createReview({ identity, currentSessionId: firstSessionId, headSha: firstSha, createdAt: now });
    const { value } = controller({ existing: unrefreshed, refresh });

    await expect(value.open({ profileId: "cfw", host: "github.com", owner: "centraldigital", repo: "patchdesk", number: 42 })).resolves.toMatchObject({ _tag: "ok" });
    expect(refresh.refresh).toHaveBeenCalledWith({ profileId, reviewId: unrefreshed.id });
  });

  it("resumes same-head open without advancing the stable Review", async () => {
    const existing = review();
    const { value, save } = controller({ existing });
    const opened = await value.open({ profileId: "cfw", host: "github.com", owner: "centraldigital", repo: "patchdesk", number: 42 });
    expect(opened._tag).toBe("ok");
    expect(save).not.toHaveBeenCalled();
  });

  it("keeps the represented revision when GitHub has advanced until explicit Refresh", async () => {
    const existing = review();
    const { value, prepareCalls, save } = controller({ existing, preparedSessionId: secondSessionId, preparedHead: secondSha });
    const opened = await value.open({ profileId: "cfw", host: "github.com", owner: "centraldigital", repo: "patchdesk", number: 42 });
    expect(opened._tag).toBe("ok");
    expect(prepareCalls).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it("uses local session data when the represented snapshot head mismatches the Review head", async () => {
    const existing = { ...review(), representedRemote: { ...representedRemote, headSha: secondSha } };
    const loadLocal = vi.fn(async () => ok(projection()));
    const loadRepresented = vi.fn(async () => ok(projection()));
    const { value } = controller({ existing, loadLocal, loadRepresented });
    const opened = await value.open({ profileId: "cfw", host: "github.com", owner: "centraldigital", repo: "patchdesk", number: 42 });
    expect(opened._tag).toBe("ok");
    expect(loadLocal).toHaveBeenCalledOnce();
    expect(loadRepresented).not.toHaveBeenCalled();
  });

  it("does not prepare or mutate a terminal Review", async () => {
    const existing = markReviewTerminal(review(), "merged", later);
    const { value, prepareCalls, save } = controller({ existing });
    const opened = await value.open({ profileId: "cfw", host: "github.com", owner: "centraldigital", repo: "patchdesk", number: 42 });
    expect(opened._tag).toBe("ok");
    expect(prepareCalls).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it("loads a saved workbench by session identity", async () => {
    const load = vi.fn(async () => ok(projection()));
    const { value } = controller({ existing: review(), load });
    const result = await value.load({ profileId: "cfw", sessionId: firstSessionId });
    expect(result).toEqual({ _tag: "ok", value: { state: "review" } });
    expect(load).toHaveBeenCalledWith({ profileId, sessionId: firstSessionId });
  });

  it("validates and delegates commit diff requests", async () => {
    const diff = vi.fn(async () => ok({ commit: {}, position: 1, total: 1, patch: "diff", fileCount: 0, additions: 0, deletions: 0 }));
    const { value } = controller({ commits: { diff } });
    await expect(value.commitDiff({ profileId: "cfw", reviewId: "not-a-review", commitSha: "1".repeat(40) })).resolves.toEqual({ _tag: "err", error: { reason: "invalid_input" } });
    const validReviewId = review().id;
    const result = await value.commitDiff({ profileId: "cfw", reviewId: validReviewId, commitSha: "1".repeat(40) });
    expect(result._tag).toBe("ok");
    expect(diff).toHaveBeenCalledWith({ profileId, reviewId: validReviewId, commitSha: firstSha });
  });
});
