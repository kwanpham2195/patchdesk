import { describe, expect, it, vi } from "vitest";

import { FakeGitHubAdapter } from "../../src/adapters/github/github-adapter";
import {
  CommandRunner,
  type CommandExecution,
  type CommandExecutor,
  type CommandRequest,
} from "../../src/adapters/github/command-runner";
import { PatchdeskPaths } from "../../src/adapters/storage/patchdesk-paths";
import { ProfileStore } from "../../src/adapters/storage/profile-store";
import type { StorageFailure } from "../../src/adapters/storage/json-file";
import {
  parsePatchdeskConfig,
  type PatchdeskConfigFile,
} from "../../src/domain/contracts";
import {
  parseAbsolutePath,
  parseGitHubHost,
  parseGitHubOwner,
  parseGitHubRepoName,
} from "../../src/domain/ids";
import { parseWorkspaceProfileConfig } from "../../src/domain/workspace-profile";
import { err, ok, type Result } from "../../src/domain/result";
import { DashboardService } from "../../src/services/dashboard-service";
import { DashboardController } from "../../src/services/dashboard-controller";
import {
  addWatchedRepo,
  detectDefaultWorkspaceProfile,
  ProfileSettingsService,
  removeWatchedRepo,
  updateWatchedRepoPath,
} from "../../src/services/profile-service";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";

class FakeCommandExecutor implements CommandExecutor {
  constructor(private readonly execution: CommandExecution) {}

  execute(_input: CommandRequest): Promise<CommandExecution> {
    return Promise.resolve(this.execution);
  }
}

const expectedHomeWorkspaceRoot = (() => {
  const parsed = parseAbsolutePath(homedir());
  return parsed._tag === "ok" ? [parsed.value] : [];
})();

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
};

describe("profile settings and dashboard services", () => {
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

  it("derives the first-run default profile from the machine's active gh account and home directory", async () => {
    const commands = new CommandRunner(
      new FakeCommandExecutor({
        _tag: "Exited",
        exitCode: 0,
        stdout: "octocat\n",
        stderr: "",
      }),
    );
    const detected = await detectDefaultWorkspaceProfile(commands);
    expect(detected).toMatchObject({
      _tag: "ok",
      value: {
        id: "default",
        label: "Default",
        githubHost: "github.com",
        ghAccount: "octocat",
        ownerFilters: [],
        workspaceRoots: expectedHomeWorkspaceRoot,
        repos: [],
      },
    });
  });

  it("falls back to an empty ghAccount, never a fabricated identity, when gh detection fails", async () => {
    const commands = new CommandRunner(
      new FakeCommandExecutor({ _tag: "Unavailable" }),
    );
    const detected = await detectDefaultWorkspaceProfile(commands);
    expect(detected).toMatchObject({
      _tag: "ok",
      value: {
        id: "default",
        label: "Default",
        githubHost: "github.com",
        ghAccount: "",
        ownerFilters: [],
        repos: [],
      },
    });
  });

  it("persists and selects the derived first-run default profile once gh detection succeeds", async () => {
    const root = await mkdtemp(`${tmpdir()}/patchdesk-m5-`);
    try {
      const paths = PatchdeskPaths.forTest(root);
      const store = new ProfileStore(paths);
      const commands = new CommandRunner(
        new FakeCommandExecutor({
          _tag: "Exited",
          exitCode: 0,
          stdout: "octocat\n",
          stderr: "",
        }),
      );
      const controller = new DashboardController(
        store,
        new FakeGitHubAdapter({}),
        undefined,
        paths,
        commands,
      );

      const listed = await controller.listProfiles();
      expect(listed).toMatchObject({
        _tag: "ok",
        value: [{ id: "default", ghAccount: "octocat" }],
      });

      expect(await store.list()).toMatchObject({
        _tag: "ok",
        value: [{ id: "default", ghAccount: "octocat" }],
      });
      expect(await store.loadConfig()).toMatchObject({
        _tag: "ok",
        value: { lastSelectedProfileId: "default" },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("never persists a first-run profile when gh detection cannot find a real account", async () => {
    const root = await mkdtemp(`${tmpdir()}/patchdesk-m5-empty-`);
    try {
      const paths = PatchdeskPaths.forTest(root);
      const store = new ProfileStore(paths);
      const commands = new CommandRunner(
        new FakeCommandExecutor({ _tag: "Unavailable" }),
      );
      const controller = new DashboardController(
        store,
        new FakeGitHubAdapter({}),
        undefined,
        paths,
        commands,
      );

      const listed = await controller.listProfiles();
      expect(listed).toMatchObject({
        _tag: "ok",
        value: [{ id: "default", ghAccount: "", ownerFilters: [] }],
      });

      // The profile schema requires a non-empty ghAccount (workspace-profile.ts),
      // so an undetectable account must never be written to disk or auto-selected.
      expect(await store.list()).toEqual({ _tag: "ok", value: [] });
      expect(await store.loadConfig()).toEqual({
        _tag: "err",
        error: expect.objectContaining({ reason: "not_found" }),
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

  it("reports github_auth on an empty watchlist when gh is unauthenticated, not a false available", async () => {
    const root = await mkdtemp(`${tmpdir()}/patchdesk-access-check-`);
    try {
      const paths = PatchdeskPaths.forTest(root);
      const store = new ProfileStore(paths);
      const emptyWatchlistProfile = mustParse(
        parseWorkspaceProfileConfig({ ...profile, repos: [] }),
      );
      await store.save(emptyWatchlistProfile);
      const controller = new DashboardController(
        store,
        new FakeGitHubAdapter({}),
        undefined,
        paths,
      );

      // With no watched repos there is no repo to attach an auth failure
      // to, so testGitHubAccess must consult authentication directly
      // instead of inferring it from an empty per-repo list.
      expect(await controller.testGitHubAccess()).toEqual({
        _tag: "ok",
        value: { state: "github_auth" },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports available on an empty watchlist when gh is authenticated", async () => {
    const root = await mkdtemp(`${tmpdir()}/patchdesk-access-check-ok-`);
    try {
      const paths = PatchdeskPaths.forTest(root);
      const store = new ProfileStore(paths);
      const emptyWatchlistProfile = mustParse(
        parseWorkspaceProfileConfig({ ...profile, repos: [] }),
      );
      await store.save(emptyWatchlistProfile);
      const controller = new DashboardController(
        store,
        new FakeGitHubAdapter({
          authenticatedAccount: { host: "github.com", account: "pmquan2cfw" },
        }),
        undefined,
        paths,
      );

      expect(await controller.testGitHubAccess()).toEqual({
        _tag: "ok",
        value: { state: "available" },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns an empty ok inbox for an empty watchlist without reading GitHub (first-run screen)", async () => {
    const root = await mkdtemp(`${tmpdir()}/patchdesk-inbox-empty-watchlist-`);
    try {
      const paths = PatchdeskPaths.forTest(root);
      const store = new ProfileStore(paths);
      const emptyWatchlistProfile = mustParse(
        parseWorkspaceProfileConfig({ ...profile, repos: [] }),
      );
      await store.save(emptyWatchlistProfile);
      const listMaintainerPullRequests = vi.fn(async (): Promise<never> => {
        throw new Error("GitHub must not be read for an empty watchlist");
      });
      const controller = new DashboardController(
        store,
        // SAFETY: an empty watchlist has no repository to read, so
        // inboxForActiveProfile must return before reaching any member of
        // this fixture other than the one it deliberately throws from.
        { listMaintainerPullRequests } as never,
        undefined,
        paths,
      );

      const result = await controller.inboxForActiveProfile(undefined, {
        filter: { state: "open" },
        pageSize: 25,
      });

      expect(result).toMatchObject({
        _tag: "ok",
        value: {
          inbox: {
            rows: [],
            repositories: [],
            dataFreshness: "fresh",
            snapshot: { state: "current" },
          },
        },
      });
      expect(listMaintainerPullRequests).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
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

  override async loadConfig(): Promise<
    Result<PatchdeskConfigFile, StorageFailure>
  > {
    return ok(this.config);
  }

  override async saveConfig(
    config: PatchdeskConfigFile,
  ): Promise<Result<void, StorageFailure>> {
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
  it("discovers git-origin suggestions with their local checkout paths", async () => {
    const service = new DashboardService({
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
