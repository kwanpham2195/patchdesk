import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  MaintainerInboxCacheStore,
  parseMaintainerInboxCache,
} from "../../src/adapters/storage/maintainer-inbox-cache-store";
import { PatchdeskPaths } from "../../src/adapters/storage/patchdesk-paths";
import {
  parseGitHubHost,
  parseGitHubOwner,
  parseGitHubRepoName,
  parseGitSha,
  parseIsoTimestamp,
  parsePullRequestNumber,
  parseWorkspaceProfileId,
  type WorkspaceProfileId,
} from "../../src/domain/ids";

const directories: Array<string> = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map(
        async (directory) =>
          await rm(directory, { force: true, recursive: true }),
      ),
  );
});

function must<T, E>(
  result:
    | { readonly _tag: "ok"; readonly value: T }
    | { readonly _tag: "err"; readonly error: E },
): T {
  if (result._tag === "err") throw new Error("Expected parsed fixture");
  return result.value;
}

async function fixtureStore(): Promise<{
  readonly store: MaintainerInboxCacheStore;
  readonly profileId: WorkspaceProfileId;
}> {
  const root = await mkdtemp(join(tmpdir(), "patchdesk-inbox-cache-"));
  directories.push(root);
  return {
    store: new MaintainerInboxCacheStore(PatchdeskPaths.forTest(root)),
    profileId: must(parseWorkspaceProfileId("cfw")),
  };
}

const updatedAt = must(parseIsoTimestamp("2026-07-18T00:00:00.000Z"));
const sha = must(parseGitSha("abcdef1234567890abcdef1234567890abcdef12"));
const repository = {
  host: must(parseGitHubHost("github.com")),
  owner: must(parseGitHubOwner("centraldigital")),
  repo: must(parseGitHubRepoName("patchdesk")),
};

describe("maintainer inbox cache store", () => {
  it("round-trips only parsed JSON-safe inbox data", async () => {
    const { store, profileId } = await fixtureStore();
    const cache = {
      schemaVersion: 1 as const,
      refreshedAt: updatedAt,
      rows: [
        {
          remoteState: "open" as const,
          identity: {
            host: must(parseGitHubHost("github.com")),
            owner: must(parseGitHubOwner("centraldigital")),
            repo: must(parseGitHubRepoName("patchdesk")),
            number: must(parsePullRequestNumber(42)),
          },
          title: "Guard duplicate input",
          author: "author",
          baseBranch: "sit",
          headBranch: "feature/duplicate-guard",
          currentHeadSha: sha,
          isDraft: false,
          updatedAt,
          changeStats: { additions: 8, deletions: 2, changedFiles: 1 },
          checks: { overall: "passing" as const, checks: [] },
          reviewState: "none" as const,
          mergeability: "unknown" as const,
          labels: [],
          categories: ["updated_since_review"] as const,
          recommendedAction: {
            kind: "run_review" as const,
            label: "Run review" as const,
          },
          dataFreshness: "fresh" as const,
        },
      ],
      repository: {
        identity: repository,
        state: "ready" as const,
        complete: true,
      },
    };
    expect(await store.save(profileId, repository, cache)).toEqual({
      _tag: "ok",
      value: undefined,
    });
    expect(await store.read(profileId, repository)).toEqual({
      _tag: "ok",
      value: cache,
    });
  });

  it("round-trips the Brief tag, so a tagged row does not invalidate the cache", async () => {
    const { store, profileId } = await fixtureStore();
    const cache = {
      schemaVersion: 1 as const,
      refreshedAt: updatedAt,
      rows: [
        {
          remoteState: "open" as const,
          identity: {
            host: must(parseGitHubHost("github.com")),
            owner: must(parseGitHubOwner("centraldigital")),
            repo: must(parseGitHubRepoName("patchdesk")),
            number: must(parsePullRequestNumber(42)),
          },
          title: "Guard duplicate input",
          author: "author",
          baseBranch: "sit",
          headBranch: "feature/duplicate-guard",
          currentHeadSha: sha,
          isDraft: false,
          updatedAt,
          changeStats: {},
          checks: { overall: "passing" as const, checks: [] },
          reviewState: "none" as const,
          mergeability: "unknown" as const,
          briefReady: true as const,
          labels: [],
          categories: [],
          recommendedAction: {
            kind: "run_review" as const,
            label: "Run review" as const,
          },
          dataFreshness: "fresh" as const,
        },
      ],
      repository: {
        identity: repository,
        state: "ready" as const,
        complete: true,
      },
    };
    expect(await store.save(profileId, repository, cache)).toEqual({
      _tag: "ok",
      value: undefined,
    });
    expect(await store.read(profileId, repository)).toEqual({
      _tag: "ok",
      value: cache,
    });
  });

  it("round-trips a github_forbidden repository state (plan 009 picklist lockstep regression)", async () => {
    const { store, profileId } = await fixtureStore();
    const forbiddenRepository = {
      host: must(parseGitHubHost("github.com")),
      owner: must(parseGitHubOwner("OmisePayments")),
      repo: must(parseGitHubRepoName("dynamic-onboarding-service")),
    };
    const cache = {
      schemaVersion: 1 as const,
      refreshedAt: updatedAt,
      rows: [],
      repository: {
        identity: forbiddenRepository,
        state: "github_forbidden" as const,
        complete: false,
      },
    };
    expect(await store.save(profileId, forbiddenRepository, cache)).toEqual({
      _tag: "ok",
      value: undefined,
    });
    expect(await store.read(profileId, forbiddenRepository)).toEqual({
      _tag: "ok",
      value: cache,
    });
  });

  it("round-trips a row carrying labels and labelCount", async () => {
    const { store, profileId } = await fixtureStore();
    const cache = {
      schemaVersion: 1 as const,
      refreshedAt: updatedAt,
      rows: [
        {
          remoteState: "open" as const,
          identity: {
            host: must(parseGitHubHost("github.com")),
            owner: must(parseGitHubOwner("centraldigital")),
            repo: must(parseGitHubRepoName("patchdesk")),
            number: must(parsePullRequestNumber(42)),
          },
          title: "Guard duplicate input",
          author: "author",
          baseBranch: "sit",
          headBranch: "feature/duplicate-guard",
          currentHeadSha: sha,
          isDraft: false,
          updatedAt,
          changeStats: { additions: 8, deletions: 2, changedFiles: 1 },
          checks: { overall: "passing" as const, checks: [] },
          reviewState: "none" as const,
          mergeability: "unknown" as const,
          labels: [{ name: "bug", color: "d73a4a" }],
          labelCount: 5,
          categories: ["updated_since_review"] as const,
          recommendedAction: {
            kind: "run_review" as const,
            label: "Run review" as const,
          },
          dataFreshness: "fresh" as const,
        },
      ],
      repository: {
        identity: repository,
        state: "ready" as const,
        complete: true,
      },
    };
    expect(await store.save(profileId, repository, cache)).toEqual({
      _tag: "ok",
      value: undefined,
    });
    expect(await store.read(profileId, repository)).toEqual({
      _tag: "ok",
      value: cache,
    });
  });

  it("parses a pre-labels cache row that omits `labels` entirely, defaulting it to an empty array (no invalidation of old caches)", () => {
    const parsed = parseMaintainerInboxCache({
      schemaVersion: 1,
      refreshedAt: updatedAt,
      rows: [
        {
          identity: {
            host: "github.com",
            owner: "centraldigital",
            repo: "patchdesk",
            number: 42,
          },
          title: "Guard duplicate input",
          author: "author",
          baseBranch: "sit",
          headBranch: "feature/duplicate-guard",
          currentHeadSha: sha,
          isDraft: false,
          updatedAt,
          changeStats: {},
          checks: { overall: "passing", checks: [] },
          reviewState: "none",
          mergeability: "unknown",
          categories: ["updated_since_review"],
          recommendedAction: {
            kind: "run_review",
            label: "Run review",
          },
          dataFreshness: "fresh",
        },
      ],
      repository: {
        identity: {
          host: "github.com",
          owner: "centraldigital",
          repo: "patchdesk",
        },
        state: "ready",
        complete: true,
      },
    });

    expect(parsed).toMatchObject({
      _tag: "ok",
      value: { rows: [{ labels: [] }] },
    });
    if (parsed._tag === "ok")
      expect(parsed.value.rows[0]).not.toHaveProperty("labelCount");
  });

  it("upgrades a cached failed-check action to a review action", () => {
    const parsed = parseMaintainerInboxCache({
      schemaVersion: 1,
      refreshedAt: updatedAt,
      rows: [
        {
          identity: {
            host: "github.com",
            owner: "centraldigital",
            repo: "patchdesk",
            number: 42,
          },
          title: "Guard duplicate input",
          author: "author",
          baseBranch: "sit",
          headBranch: "feature/duplicate-guard",
          currentHeadSha: sha,
          isDraft: false,
          updatedAt,
          changeStats: {},
          checks: { overall: "failing", checks: [] },
          reviewState: "none",
          mergeability: "blocked",
          categories: ["updated_since_review"],
          recommendedAction: {
            kind: "inspect_checks",
            label: "Inspect failing checks",
          },
          dataFreshness: "cached",
        },
      ],
      repository: {
        identity: {
          host: "github.com",
          owner: "centraldigital",
          repo: "patchdesk",
        },
        state: "ready",
        complete: true,
      },
    });

    expect(parsed).toMatchObject({
      _tag: "ok",
      value: {
        rows: [
          { recommendedAction: { kind: "run_review", label: "Run review" } },
        ],
      },
    });
  });

  it("reads back a check whose url is an empty string (a v.url() refinement here rejected data the cache itself wrote)", async () => {
    const { store, profileId } = await fixtureStore();
    const cache = {
      schemaVersion: 1 as const,
      refreshedAt: updatedAt,
      rows: [
        {
          remoteState: "open" as const,
          identity: {
            host: must(parseGitHubHost("github.com")),
            owner: must(parseGitHubOwner("centraldigital")),
            repo: must(parseGitHubRepoName("patchdesk")),
            number: must(parsePullRequestNumber(42)),
          },
          title: "Guard duplicate input",
          author: "author",
          baseBranch: "sit",
          headBranch: "feature/duplicate-guard",
          currentHeadSha: sha,
          isDraft: false,
          updatedAt,
          changeStats: {},
          // The wire projection drops only `null`/`undefined` from
          // `details_url`, so an empty-string URL reaches the cache file
          // verbatim — and must read back, or save() writes a cache that
          // read() then discards whole.
          checks: {
            overall: "failing" as const,
            checks: [
              {
                name: "build",
                required: "unknown" as const,
                status: "completed" as const,
                conclusion: "failure" as const,
                url: "",
              },
            ],
          },
          reviewState: "none" as const,
          mergeability: "unknown" as const,
          labels: [],
          categories: [],
          recommendedAction: {
            kind: "run_review" as const,
            label: "Run review" as const,
          },
          dataFreshness: "fresh" as const,
        },
      ],
      repository: {
        identity: repository,
        state: "ready" as const,
        complete: true,
      },
    };
    expect(await store.save(profileId, repository, cache)).toEqual({
      _tag: "ok",
      value: undefined,
    });
    expect(await store.read(profileId, repository)).toEqual({
      _tag: "ok",
      value: cache,
    });
  });

  it("reads back a check whose name is an empty string (a minLength(1) refinement here rejected data the cache itself wrote)", async () => {
    const { store, profileId } = await fixtureStore();
    const cache = {
      schemaVersion: 1 as const,
      refreshedAt: updatedAt,
      rows: [
        {
          remoteState: "open" as const,
          identity: {
            host: must(parseGitHubHost("github.com")),
            owner: must(parseGitHubOwner("centraldigital")),
            repo: must(parseGitHubRepoName("patchdesk")),
            number: must(parsePullRequestNumber(43)),
          },
          title: "Guard duplicate input",
          author: "author",
          baseBranch: "sit",
          headBranch: "feature/duplicate-guard",
          currentHeadSha: sha,
          isDraft: false,
          updatedAt,
          changeStats: {},
          // `github-wire-schemas.ts` types a check run's `name` as a plain
          // `v.string()`, so GitHub may send `""` and the wire projection
          // carries it through unchanged. The url here is deliberately a
          // well-formed absolute one, so this case turns on `name` alone.
          checks: {
            overall: "failing" as const,
            checks: [
              {
                name: "",
                required: "unknown" as const,
                status: "completed" as const,
                conclusion: "failure" as const,
                url: "https://github.com/centraldigital/patchdesk/runs/1",
              },
            ],
          },
          reviewState: "none" as const,
          mergeability: "unknown" as const,
          labels: [],
          categories: [],
          recommendedAction: {
            kind: "run_review" as const,
            label: "Run review" as const,
          },
          dataFreshness: "fresh" as const,
        },
      ],
      repository: {
        identity: repository,
        state: "ready" as const,
        complete: true,
      },
    };
    expect(await store.save(profileId, repository, cache)).toEqual({
      _tag: "ok",
      value: undefined,
    });
    expect(await store.read(profileId, repository)).toEqual({
      _tag: "ok",
      value: cache,
    });
  });

  it("rejects credential-like data before writing the cache", async () => {
    const { store, profileId } = await fixtureStore();
    expect(
      // SAFETY: test fixture deliberately adds a `note` field outside
      // MaintainerInboxCache's declared shape to prove save() rejects a
      // credential-like value even when it rides along on an otherwise
      // valid cache payload; `as never` only bypasses the compile-time
      // shape check for this intentionally-invalid fixture.
      await store.save(profileId, repository, {
        schemaVersion: 1,
        refreshedAt: updatedAt,
        rows: [],
        repository: {
          identity: repository,
          state: "github_read",
          complete: false,
        },
        note: "ghp_123456789012345678901234567890",
      } as never),
    ).toEqual({
      _tag: "err",
      error: {
        _tag: "StorageFailure",
        operation: "write",
        reason: "sensitive_value",
      },
    });
  });
});
