import { describe, expect, it } from "vitest";

import { FakeGitHubAdapter } from "../../src/adapters/github/github-adapter";
import { PatchdeskPaths } from "../../src/adapters/storage/patchdesk-paths";
import { ProfileStore } from "../../src/adapters/storage/profile-store";
import type { StorageFailure } from "../../src/adapters/storage/json-file";
import {
  parsePatchdeskConfig,
  type PatchdeskConfigFile,
} from "../../src/domain/contracts";
import {
  parseGitHubHost,
  parseGitHubOwner,
  parseGitHubRepoName,
  parseGitSha,
  parseIsoTimestamp,
  parsePullRequestNumber,
} from "../../src/domain/ids";
import type { PullRequestSummary } from "../../src/domain/github-context";
import { parseWorkspaceProfileConfig } from "../../src/domain/workspace-profile";
import { err, ok, type Result } from "../../src/domain/result";
import { DashboardService } from "../../src/services/dashboard-service";
import { DashboardController } from "../../src/services/dashboard-controller";
import {
  addWatchedRepo,
  createDefaultCfwProfile,
  ProfileSettingsService,
  removeWatchedRepo,
  updateWatchedRepoPath,
} from "../../src/services/profile-service";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  parsePullRequestEntry,
  profileSwitchConfirmation,
  suggestProfile,
} from "../../src/services/pull-request-input-service";

function mustParse<T, E>(
  result:
    | { readonly _tag: "ok"; readonly value: T }
    | { readonly _tag: "err"; readonly error: E },
): T {
  if (result._tag === "err") throw new Error("Expected fixture to parse");
  return result.value;
}

const profile = mustParse(
  parseWorkspaceProfileConfig({
    id: "cfw",
    label: "CFW",
    githubHost: "github.com",
    ghAccount: "pmquan2cfw",
    ownerFilters: ["centraldigital"],
    workspaceRoots: ["/workspace"],
    rulePaths: [],
    repos: [
      {
        host: "github.com",
        owner: "centraldigital",
        repo: "patchdesk",
        localPath: "/workspace/patchdesk",
      },
    ],
  }),
);

const ids = {
  host: mustParse(parseGitHubHost("github.com")),
  owner: mustParse(parseGitHubOwner("centraldigital")),
  repo: mustParse(parseGitHubRepoName("patchdesk")),
  sha: mustParse(parseGitSha("abcdef1234567890abcdef1234567890abcdef12")),
  updated: mustParse(parseIsoTimestamp("2026-07-16T00:00:00.000Z")),
};

function summary(
  number: number,
  overrides: Partial<PullRequestSummary> = {},
): PullRequestSummary {
  return {
    ref: {
      host: ids.host,
      owner: ids.owner,
      repo: ids.repo,
      number: mustParse(parsePullRequestNumber(number)),
    },
    title: `PR ${number}`,
    author: "another-user",
    headBranch: "feature",
    baseBranch: "sit",
    headSha: ids.sha,
    isDraft: false,
    isOpen: true,
    reviewState: "none",
    mergeability: "mergeable",
    labels: [],
    updatedAt: ids.updated,
    ...overrides,
  };
}

describe("profile settings and direct-entry services", () => {
  it("persists editable owner filters and rule paths while preserving watched repositories", async () => {
    const root = await mkdtemp(`${tmpdir()}/patchdesk-profile-editor-`);
    try {
      const paths = PatchdeskPaths.forTest(root);
      const store = new ProfileStore(paths);
      await store.save(profile);
      const controller = new DashboardController(
        store,
        new FakeGitHubAdapter({}),
        undefined,
        paths,
      );

      const saved = await controller.saveProfile({
        id: "cfw",
        label: "CFW updated",
        githubHost: "github.com",
        ghAccount: "patchdesk",
        ownerFilters: ["centraldigital", "platform"],
        workspaceRoots: ["/workspace/cfw", "/workspace/platform"],
        rulePaths: ["/workspace/cfw/AGENTS.md"],
      });

      expect(saved).toMatchObject({
        _tag: "ok",
        value: {
          ownerFilters: ["centraldigital", "platform"],
          workspaceRoots: ["/workspace/cfw", "/workspace/platform"],
          rulePaths: ["/workspace/cfw/AGENTS.md"],
          repos: [{ repo: "patchdesk" }],
        },
      });
      expect(await store.load(profile.id)).toMatchObject({
        _tag: "ok",
        value: {
          ownerFilters: ["centraldigital", "platform"],
          rulePaths: ["/workspace/cfw/AGENTS.md"],
          repos: [{ repo: "patchdesk" }],
        },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("persists a selected profile and provides the safe CFW example only as a local default", async () => {
    const root = await mkdtemp(`${tmpdir()}/patchdesk-m5-`);
    try {
      const service = new ProfileSettingsService(
        new ProfileStore(PatchdeskPaths.forTest(root)),
      );
      const created = createDefaultCfwProfile();
      expect(created).toMatchObject({
        _tag: "ok",
        value: { id: "cfw", ghAccount: "pmquan2cfw", repos: [] },
      });
      if (created._tag === "err") return;
      expect(await service.saveProfile(created.value)).toEqual({
        _tag: "ok",
        value: undefined,
      });
      expect(await service.selectProfile(created.value.id)).toEqual({
        _tag: "ok",
        value: created.value.id,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps a concurrent settings update when selecting a profile", async () => {
    const store = new BlockingFirstConfigSaveStore();
    const service = new ProfileSettingsService(store);

    const selected = service.selectProfile(profile.id);
    await store.firstConfigSaveStarted;
    const updated = service.updateSettings({ appearance: "dark" });
    store.releaseFirstConfigSave();

    await expect(Promise.all([selected, updated])).resolves.toEqual([
      { _tag: "ok", value: profile.id },
      {
        _tag: "ok",
        value: { lastSelectedProfileId: profile.id, appearance: "dark" },
      },
    ]);
    expect(store.config).toEqual({
      lastSelectedProfileId: profile.id,
      appearance: "dark",
    });
  });

  it("maintains an explicit watchlist without adding discovery suggestions", () => {
    const extra = {
      host: ids.host,
      owner: ids.owner,
      repo: mustParse(parseGitHubRepoName("new-repo")),
    };
    const added = addWatchedRepo(profile, extra);
    expect(added).toMatchObject({
      _tag: "ok",
      value: { repos: [{ repo: "patchdesk" }, { repo: "new-repo" }] },
    });
    if (added._tag === "err") return;
    const updated = updateWatchedRepoPath(
      added.value,
      extra,
      "/workspace/new-repo",
    );
    expect(updated).toMatchObject({ _tag: "ok" });
    if (updated._tag === "err") return;
    expect(updated.value.repos[1]).toMatchObject({
      repo: "new-repo",
      localPath: "/workspace/new-repo",
    });
    expect(removeWatchedRepo(updated.value, extra)).toMatchObject({
      _tag: "ok",
      value: { repos: [{ repo: "patchdesk" }] },
    });
  });

  it("parses every direct PR entry form and never applies owner filters as an admission rule", () => {
    expect(
      parsePullRequestEntry(
        "https://github.com/other-org/service/pull/4",
        profile.githubHost,
      ),
    ).toMatchObject({
      _tag: "ok",
      value: { owner: "other-org", repo: "service", number: 4 },
    });
    expect(
      parsePullRequestEntry("centraldigital/patchdesk#42", profile.githubHost),
    ).toMatchObject({ _tag: "ok" });
    const enterpriseHost = mustParse(parseGitHubHost("github.example.test"));
    expect(
      parsePullRequestEntry("outside/service#7", enterpriseHost),
    ).toMatchObject({ _tag: "ok", value: { host: "github.example.test" } });
    expect(
      parsePullRequestEntry(
        {
          _tag: "SelectedDashboardPr",
          profileId: profile.id,
          pr: summary(9).ref,
        },
        profile.githubHost,
      ),
    ).toMatchObject({ _tag: "ok", value: { number: 9 } });
    expect(
      parsePullRequestEntry(
        {
          _tag: "SeparateFields",
          owner: "outside",
          repo: "service",
          number: 8,
        },
        profile.githubHost,
      ),
    ).toMatchObject({
      _tag: "ok",
      value: { owner: "outside", repo: "service", number: 8 },
    });
  });

  it("suggests a matching profile and requires confirmation before switching", () => {
    const githubEnterprise = mustParse(
      parseWorkspaceProfileConfig({
        ...profile,
        id: "enterprise",
        label: "Enterprise",
        githubHost: "github.example.test",
        ghAccount: "octo",
        repos: [],
      }),
    );
    const pr = mustParse(
      parsePullRequestEntry(
        "https://github.example.test/octo/service/pull/3",
        profile.githubHost,
      ),
    );
    expect(suggestProfile(pr, [profile, githubEnterprise])).toEqual({
      _tag: "ok",
      value: githubEnterprise.id,
    });
    expect(profileSwitchConfirmation(profile, githubEnterprise, pr)).toEqual({
      required: true,
      targetProfileId: githubEnterprise.id,
      reason: "host_changed",
    });
  });
});

class BlockingFirstConfigSaveStore extends ProfileStore {
  private firstConfigSaveRelease: (() => void) | undefined;
  private readonly firstConfigSaveGate: Promise<void>;
  private firstConfigSaveStartedResolve: (() => void) | undefined;
  private configSaveCount = 0;
  config: PatchdeskConfigFile = {};
  readonly firstConfigSaveStarted: Promise<void>;

  constructor() {
    super(PatchdeskPaths.forTest("/tmp/patchdesk-profile-settings-race"));
    this.firstConfigSaveGate = new Promise<void>((resolve) => {
      this.firstConfigSaveRelease = resolve;
    });
    this.firstConfigSaveStarted = new Promise<void>((resolve) => {
      this.firstConfigSaveStartedResolve = resolve;
    });
  }

  override async loadConfig(): Promise<Result<PatchdeskConfigFile, StorageFailure>> {
    return ok(this.config);
  }

  override async saveConfig(config: unknown): Promise<Result<void, StorageFailure>> {
    const parsed = parsePatchdeskConfig(config);
    if (parsed._tag === "err") {
      return err({
        _tag: "StorageFailure",
        operation: "write",
        reason: "invalid_stored_value",
      });
    }
    if (this.configSaveCount === 0) {
      this.configSaveCount += 1;
      const signalStarted = this.firstConfigSaveStartedResolve;
      if (signalStarted === undefined) {
        throw new Error("First config save signal was not initialized.");
      }
      signalStarted();
      await this.firstConfigSaveGate;
    }
    this.config = parsed.value;
    return ok(undefined);
  }

  releaseFirstConfigSave(): void {
    const release = this.firstConfigSaveRelease;
    if (release === undefined) {
      throw new Error("First config save gate was not initialized.");
    }
    release();
  }
}

describe("dashboard service", () => {
  it("sorts review-requested, assigned, recent, then draft/authored PRs and keeps missing paths degraded", async () => {
    const adapter = new FakeGitHubAdapter({
      listOpenPullRequests: [
        summary(4, { isDraft: true }),
        summary(3, { author: "pmquan2cfw" }),
        summary(2, { assignees: ["pmquan2cfw"] }),
        summary(1, { requestedReviewers: ["pmquan2cfw"] }),
      ],
      authenticatedAccount: { host: "github.com", account: "pmquan2cfw" },
    });
    const service = new DashboardService(adapter);
    const result = await service.listPendingPullRequests(profile);

    expect(result).toMatchObject({
      _tag: "ok",
      value: {
        rows: [
          { summary: { ref: { number: 1 } }, priority: "review_requested" },
          { summary: { ref: { number: 2 } }, priority: "assigned" },
          { summary: { ref: { number: 3 } }, priority: "recently_updated" },
          { summary: { ref: { number: 4 } }, priority: "draft" },
        ],
      },
    });
  });

  it("returns repo-level auth failure while preserving direct PR entry", async () => {
    const service = new DashboardService(new FakeGitHubAdapter({}));
    const result = await service.listPendingPullRequests(profile);
    expect(result).toEqual({
      _tag: "ok",
      value: {
        rows: [],
        repos: [{ repo: profile.repos[0], state: "github_auth" }],
        directEntryAvailable: true,
      },
    });
  });

  it("discovers git-origin suggestions with their local checkout paths", async () => {
    const service = new DashboardService(new FakeGitHubAdapter({}), {
      async findOrigins() {
        return [
          {
            origin: "https://github.com/centraldigital/discovered.git",
            localPath: "/workspace/discovered",
          },
          {
            origin: "git@github.com:centraldigital/patchdesk.git",
            localPath: "/workspace/patchdesk",
          },
        ];
      },
    });
    expect(await service.discoverWorkspaceRepos(profile)).toEqual({
      _tag: "ok",
      value: [
        {
          host: "github.com",
          owner: "centraldigital",
          repo: "discovered",
          localPath: "/workspace/discovered",
        },
      ],
    });
  });
});
