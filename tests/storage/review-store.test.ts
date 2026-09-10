import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { PatchdeskPaths } from "../../src/adapters/storage/patchdesk-paths";
import { ReviewStore } from "../../src/adapters/storage/review-store";
import {
  createReview,
  markReviewOpened,
  markReviewTerminal,
  type ReviewIdentity,
} from "../../src/domain/review";
import {
  createReviewId,
  createReviewSessionId,
  parseGitHubHost,
  parseGitHubOwner,
  parseGitHubRepoName,
  parseGitSha,
  parseIsoTimestamp,
  parsePullRequestNumber,
  parseWorkspaceProfileId,
} from "../../src/domain/ids";
import type { Result } from "../../src/domain/result";

function must<T>(result: Result<T, unknown>): T {
  if (result._tag === "err") throw new Error("Invalid fixture");
  return result.value;
}

const profileId = must(parseWorkspaceProfileId("cfw"));
const otherProfileId = must(parseWorkspaceProfileId("other"));
const host = must(parseGitHubHost("github.com"));
const owner = must(parseGitHubOwner("centraldigital"));
const repo = must(parseGitHubRepoName("patchdesk"));
const anotherRepo = must(parseGitHubRepoName("patchdesk-fork"));
const prNumber = must(parsePullRequestNumber(42));
const firstSha = must(parseGitSha("1".repeat(40)));
const secondSha = must(parseGitSha("2".repeat(40)));
const baseSha = must(parseGitSha("b".repeat(40)));
const now = must(parseIsoTimestamp("2026-08-01T00:00:00.000Z"));
const later = must(parseIsoTimestamp("2026-08-01T00:01:00.000Z"));
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

function makeReview(
  headSha = firstSha,
  profile = profileId,
  repository = repo,
) {
  const identity: ReviewIdentity = {
    profileId: profile,
    host,
    owner,
    repo: repository,
    prNumber,
  };
  return createReview({
    identity,
    currentSessionId: createReviewSessionId({ ...identity, headSha, baseSha }),
    headSha,
    createdAt: now,
  });
}

async function storeFixture() {
  const root = await mkdtemp(join(tmpdir(), "patchdesk-review-store-"));
  roots.push(root);
  const paths = PatchdeskPaths.forTest(root);
  return { paths, store: new ReviewStore(paths) };
}

describe("ReviewStore", () => {
  it("round-trips atomically and lists by updatedAt", async () => {
    const { store } = await storeFixture();
    const first = makeReview();
    const second = {
      ...makeReview(secondSha, profileId, anotherRepo),
      updatedAt: later,
    };

    await expect(store.save(first)).resolves.toMatchObject({ _tag: "ok" });
    await expect(store.save(second)).resolves.toMatchObject({ _tag: "ok" });
    await expect(store.load(profileId, first.id)).resolves.toEqual({
      _tag: "ok",
      value: first,
    });
    await expect(store.list(profileId)).resolves.toMatchObject({
      _tag: "ok",
      value: { reviews: [second, first], unreadable: 0 },
    });
  });

  it("round-trips the visited-sidebar title and last-opened instant", async () => {
    const { store } = await storeFixture();
    const opened = markReviewOpened(makeReview(), {
      title: "Add the sidebar",
      now: later,
    });

    await expect(store.save(opened)).resolves.toMatchObject({ _tag: "ok" });
    await expect(store.load(profileId, opened.id)).resolves.toEqual({
      _tag: "ok",
      value: opened,
    });
  });

  it("rejects malformed stored data", async () => {
    const { paths, store } = await storeFixture();
    const review = makeReview();
    await mkdir(paths.reviewDirectory(profileId, review.id), {
      recursive: true,
    });
    await writeFile(paths.reviewFile(profileId, review.id), "{}", "utf8");

    await expect(store.load(profileId, review.id)).resolves.toMatchObject({
      _tag: "err",
      error: { reason: "invalid_stored_value" },
    });
  });

  it("does not cross profile path boundaries", async () => {
    const { store } = await storeFixture();
    const review = makeReview();
    await expect(store.save(review)).resolves.toMatchObject({ _tag: "ok" });

    await expect(store.load(otherProfileId, review.id)).resolves.toMatchObject({
      _tag: "err",
      error: { reason: "not_found" },
    });
    await expect(store.list(otherProfileId)).resolves.toEqual({
      _tag: "ok",
      value: { reviews: [], unreadable: 0 },
    });
  });

  it("skips and counts an unreadable Review while listing the readable ones", async () => {
    const { paths, store } = await storeFixture();
    const readable = makeReview();
    await expect(store.save(readable)).resolves.toMatchObject({ _tag: "ok" });
    const corrupt = createReviewId({
      ...readable.identity,
      repo: anotherRepo,
    });
    await mkdir(paths.reviewDirectory(profileId, corrupt), { recursive: true });
    await writeFile(paths.reviewFile(profileId, corrupt), "{}", "utf8");

    await expect(store.list(profileId)).resolves.toEqual({
      _tag: "ok",
      value: { reviews: [readable], unreadable: 1 },
    });
  });

  it("skips a Review deleted mid-listing without counting it unreadable", async () => {
    const { paths, store } = await storeFixture();
    const readable = makeReview();
    await expect(store.save(readable)).resolves.toMatchObject({ _tag: "ok" });
    const vanished = createReviewId({
      ...readable.identity,
      repo: anotherRepo,
    });
    await mkdir(paths.reviewDirectory(profileId, vanished), {
      recursive: true,
    });

    await expect(store.list(profileId)).resolves.toEqual({
      _tag: "ok",
      value: { reviews: [readable], unreadable: 0 },
    });
  });

  it("fails the listing when the profile directory cannot be read", async () => {
    const { paths, store } = await storeFixture();
    const workbenches = paths.profileWorkbenchesDirectory(profileId);
    await mkdir(dirname(workbenches), { recursive: true });
    await writeFile(workbenches, "not a directory", "utf8");

    await expect(store.list(profileId)).resolves.toMatchObject({
      _tag: "err",
      error: { _tag: "StorageFailure", operation: "read", reason: "io" },
    });
  });

  it("reports an existing Review owner without crossing the load boundary", async () => {
    const { store } = await storeFixture();
    const review = makeReview();
    await expect(store.save(review)).resolves.toMatchObject({ _tag: "ok" });
    await expect(store.findOwner(review.id)).resolves.toEqual({
      _tag: "ok",
      value: profileId,
    });
    await expect(
      store.findOwner(
        createReviewId({ ...review.identity, repo: anotherRepo }),
      ),
    ).resolves.toEqual({ _tag: "ok", value: undefined });
  });

  it("rejects a review whose identity does not match its destination", async () => {
    const { store } = await storeFixture();
    const review = makeReview();
    const mismatched = {
      ...review,
      identity: { ...review.identity, profileId: otherProfileId },
    };
    await expect(store.save(mismatched)).resolves.toMatchObject({
      _tag: "err",
      error: { reason: "invalid_stored_value" },
    });
  });

  it("uses the separate workbench root for Review state", async () => {
    const { paths } = await storeFixture();
    const review = makeReview();
    expect(paths.reviewFile(profileId, createReviewId(review.identity))).toBe(
      join(
        paths.dataDirectory(),
        "profiles",
        profileId,
        "workbenches",
        review.id,
        "review.json",
      ),
    );
  });

  it("rejects stale compare-and-set updates without overwriting current state", async () => {
    const { store } = await storeFixture();
    const first = makeReview();
    const current = { ...first, currentHeadSha: secondSha, updatedAt: later };
    const stale = { ...first, status: { _tag: "Open" as const } };

    await expect(store.save(first)).resolves.toMatchObject({ _tag: "ok" });
    await expect(store.save(current, first.updatedAt)).resolves.toMatchObject({
      _tag: "ok",
    });
    await expect(store.save(stale, first.updatedAt)).resolves.toMatchObject({
      _tag: "err",
      error: { _tag: "ReviewConflict", reason: "stale_revision" },
    });
    await expect(store.load(profileId, first.id)).resolves.toMatchObject({
      _tag: "ok",
      value: current,
    });
  });

  it("rejects same-millisecond compare-and-set updates", async () => {
    const { store } = await storeFixture();
    const review = makeReview();
    const firstUpdate = markReviewTerminal(review, "closed", now);
    const secondUpdate = markReviewTerminal(review, "merged", now);
    await expect(store.save(review)).resolves.toMatchObject({ _tag: "ok" });
    await expect(
      store.save(firstUpdate, review.updatedAt),
    ).resolves.toMatchObject({ _tag: "ok" });
    await expect(
      store.save(secondUpdate, review.updatedAt),
    ).resolves.toMatchObject({
      _tag: "err",
      error: { reason: "stale_revision" },
    });
  });

  it("does not replace a persisted terminal Review with an old open value", async () => {
    const { store } = await storeFixture();
    const open = makeReview();
    const terminal = markReviewTerminal(open, "merged", later);

    await expect(store.save(open)).resolves.toMatchObject({ _tag: "ok" });
    await expect(store.save(terminal, open.updatedAt)).resolves.toMatchObject({
      _tag: "ok",
    });
    await expect(store.save(open, terminal.updatedAt)).resolves.toMatchObject({
      _tag: "err",
      error: { _tag: "ReviewConflict", reason: "terminal" },
    });
    await expect(store.load(profileId, open.id)).resolves.toMatchObject({
      _tag: "ok",
      value: terminal,
    });
  });
});
