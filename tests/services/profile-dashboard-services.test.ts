import { execFileSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
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
  parseGitHubHost,
  parseGitHubOwner,
  parseGitHubRepoName,
} from "../../src/domain/ids";
import { parseWorkspaceProfileConfig } from "../../src/domain/workspace-profile";
import { err, ok, type Result } from "../../src/domain/result";
import { DashboardController } from "../../src/services/dashboard-controller";
import { createReadOnlyGitExecutor } from "../../src/main/local-api-stores";
import {
  addWatchedRepo,
  detectDefaultWorkspaceProfile,
  ProfileSettingsService,
  removeWatchedRepo,
  updateWatchedRepoPath,
} from "../../src/services/profile-service";

class FakeCommandExecutor implements CommandExecutor {
  readonly requests: CommandRequest[] = [];

  constructor(private readonly execution: CommandExecution) {}

  execute(input: CommandRequest): Promise<CommandExecution> {
    this.requests.push(input);
    return Promise.resolve(this.execution);
  }
}

/** Real git, for the checkout a maintainer chooses. */
const git = createReadOnlyGitExecutor(new CommandRunner());

/** What `gh auth status --json hosts` answers when `octocat` is the active github.com account. */
const activeGitHubAccount: CommandExecution = {
  _tag: "Exited",
  exitCode: 0,
  stdout: JSON.stringify({
    hosts: {
      "github.com": [
        {
          login: "octocat",
          host: "github.com",
          active: true,
          state: "success",
        },
      ],
    },
  }),
  stderr: "",
};

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
    id: "acme",
    label: "ACME",
    githubHost: "github.com",
    ghAccount: "octo-dev",
    rulePaths: [],
    repos: [
      {
        host: "github.com",
        owner: "octo-org",
        repo: "patchdesk",
        localPath: "/workspace/patchdesk",
      },
    ],
  }),
);

const ids = {
  host: mustParse(parseGitHubHost("github.com")),
  owner: mustParse(parseGitHubOwner("octo-org")),
};

describe("profile settings and dashboard services", () => {
  it("persists edited rule paths while preserving watched repositories", async () => {
    const root = await mkdtemp(`${tmpdir()}/patchdesk-profile-editor-`);
    try {
      const paths = PatchdeskPaths.forTest(root);
      const store = new ProfileStore(paths);
      await store.save(profile);
      const controller = new DashboardController(
        store,
        new FakeGitHubAdapter({}),
        git,
        paths,
      );

      const saved = await controller.saveProfile({
        id: "acme",
        label: "ACME updated",
        githubHost: "github.com",
        ghAccount: "patchdesk",
        rulePaths: ["/workspace/acme/AGENTS.md"],
      });

      expect(saved).toMatchObject({
        _tag: "ok",
        value: {
          rulePaths: ["/workspace/acme/AGENTS.md"],
          repos: [{ repo: "patchdesk" }],
        },
      });
      expect(await store.load(profile.id)).toMatchObject({
        _tag: "ok",
        value: {
          rulePaths: ["/workspace/acme/AGENTS.md"],
          repos: [{ repo: "patchdesk" }],
        },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("derives the profile id from the name when a create omits it", async () => {
    const root = await mkdtemp(`${tmpdir()}/patchdesk-profile-create-`);
    try {
      const paths = PatchdeskPaths.forTest(root);
      const store = new ProfileStore(paths);
      await store.save(profile);
      const controller = new DashboardController(
        store,
        new FakeGitHubAdapter({}),
        git,
        paths,
      );

      const created = await controller.saveProfile({
        label: "ACME",
        githubHost: "github.com",
        ghAccount: "patchdesk",
        rulePaths: [],
      });

      // "ACME" slugs to the stored profile's own id, so the collision suffix
      // is what keeps the create from overwriting it.
      expect(created).toMatchObject({ _tag: "ok", value: { id: "acme-2" } });
      expect(await store.load(profile.id)).toMatchObject({
        _tag: "ok",
        value: { label: "ACME", repos: [{ repo: "patchdesk" }] },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a create whose name has no slug and no id", async () => {
    const root = await mkdtemp(`${tmpdir()}/patchdesk-profile-unslug-`);
    try {
      const paths = PatchdeskPaths.forTest(root);
      const controller = new DashboardController(
        new ProfileStore(paths),
        new FakeGitHubAdapter({}),
        git,
        paths,
      );

      const created = await controller.saveProfile({
        label: "···",
        githubHost: "github.com",
        ghAccount: "patchdesk",
        rulePaths: [],
      });

      expect(created).toMatchObject({
        _tag: "err",
        error: { reason: "invalid_input" },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("derives the first-run default profile from the active gh account without reading any folder", async () => {
    const executor = new FakeCommandExecutor(activeGitHubAccount);
    const detected = await detectDefaultWorkspaceProfile(
      new CommandRunner(executor),
    );
    expect(detected).toMatchObject({
      _tag: "ok",
      value: {
        id: "default",
        label: "Default",
        githubHost: "github.com",
        ghAccount: "octocat",
        repos: [],
      },
    });
    if (detected._tag === "err") return;
    // Walking the home directory made macOS ask for Music and Photos access (#641).
    expect(detected.value).not.toHaveProperty("workspaceRoots");
    expect(executor.requests.map((request) => request.argv[0])).toEqual(["gh"]);
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
        new FakeCommandExecutor(activeGitHubAccount),
      );
      const controller = new DashboardController(
        store,
        new FakeGitHubAdapter({}),
        git,
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
        git,
        paths,
        commands,
      );

      const listed = await controller.listProfiles();
      expect(listed).toMatchObject({
        _tag: "ok",
        value: [{ id: "default", ghAccount: "" }],
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

  it("maintains an explicit watchlist", () => {
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

  it("applies a watchlist batch to the workspace the request names, not the selected one", async () => {
    const root = await mkdtemp(`${tmpdir()}/patchdesk-watchlist-named-`);
    try {
      const paths = PatchdeskPaths.forTest(root);
      const store = new ProfileStore(paths);
      const otherProfile = mustParse(
        parseWorkspaceProfileConfig({
          ...profile,
          id: "platform",
          label: "Platform",
          repos: [],
        }),
      );
      await store.save(profile);
      await store.save(otherProfile);
      const controller = new DashboardController(
        store,
        new FakeGitHubAdapter({}),
        git,
        paths,
      );
      // The selected workspace is the other one, as it is for a toggle sent
      // between `POST /v1/profiles/select` resolving and the reload landing.
      await controller.selectProfile(otherProfile.id);

      const updated = await controller.updateWatchlist({
        profileId: profile.id,
        add: [
          { host: "github.com", owner: "octo-org", repo: "new-repo" },
          { host: "github.com", owner: "octo-org", repo: "other-repo" },
        ],
        remove: [{ host: "github.com", owner: "octo-org", repo: "patchdesk" }],
      });

      expect(updated).toMatchObject({
        _tag: "ok",
        value: { id: "acme" },
      });
      expect(await store.load(profile.id)).toMatchObject({
        _tag: "ok",
        value: {
          repos: [{ repo: "new-repo" }, { repo: "other-repo" }],
        },
      });
      expect(await store.load(otherProfile.id)).toMatchObject({
        _tag: "ok",
        value: { repos: [] },
      });
      expect(await store.loadConfig()).toMatchObject({
        _tag: "ok",
        value: { lastSelectedProfileId: "platform" },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses a watchlist batch for a workspace id it does not know", async () => {
    const root = await mkdtemp(`${tmpdir()}/patchdesk-watchlist-unknown-`);
    try {
      const paths = PatchdeskPaths.forTest(root);
      const store = new ProfileStore(paths);
      await store.save(profile);
      const controller = new DashboardController(
        store,
        new FakeGitHubAdapter({}),
        git,
        paths,
      );

      const removed = await controller.updateWatchlist({
        profileId: "gone",
        add: [],
        remove: [{ host: "github.com", owner: "octo-org", repo: "patchdesk" }],
      });

      expect(removed).toEqual({
        _tag: "err",
        error: { _tag: "DashboardControllerFailure", reason: "not_found" },
      });
      expect(await store.load(profile.id)).toMatchObject({
        _tag: "ok",
        value: { repos: [{ repo: "patchdesk" }] },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("saves nothing from a watchlist batch that carries one invalid entry", async () => {
    const root = await mkdtemp(`${tmpdir()}/patchdesk-watchlist-invalid-`);
    try {
      const paths = PatchdeskPaths.forTest(root);
      const store = new ProfileStore(paths);
      await store.save(profile);
      const controller = new DashboardController(
        store,
        new FakeGitHubAdapter({}),
        git,
        paths,
      );

      const updated = await controller.updateWatchlist({
        profileId: profile.id,
        add: [
          { host: "github.com", owner: "octo-org", repo: "new-repo" },
          { host: "github.com", owner: "octo org", repo: "bad-owner" },
        ],
        remove: [{ host: "github.com", owner: "octo-org", repo: "patchdesk" }],
      });

      expect(updated).toEqual({
        _tag: "err",
        error: { _tag: "DashboardControllerFailure", reason: "invalid_input" },
      });
      expect(await store.load(profile.id)).toMatchObject({
        _tag: "ok",
        value: { repos: [{ repo: "patchdesk" }] },
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
        git,
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

describe("workspace roots retired in #641", () => {
  it("loads a v0.0.12 profile that lists workspaceRoots and writes the list back empty", async () => {
    const root = await mkdtemp(`${tmpdir()}/patchdesk-v0012-profile-`);
    try {
      const paths = PatchdeskPaths.forTest(root);
      const store = new ProfileStore(paths);
      await store.save(profile);
      const file = paths.profileFile(profile.id);
      const stored: unknown = JSON.parse(await readFile(file, "utf8"));
      await writeFile(
        file,
        JSON.stringify({
          ...(stored as object),
          workspaceRoots: ["/Users/maintainer"],
        }),
      );
      const controller = new DashboardController(
        store,
        new FakeGitHubAdapter({}),
        git,
        paths,
      );

      expect(await controller.activeProfile()).toMatchObject({
        _tag: "ok",
        value: {
          id: "acme",
          repos: [{ repo: "patchdesk", localPath: "/workspace/patchdesk" }],
        },
      });
      await controller.saveProfile({
        id: "acme",
        label: "ACME renamed",
        githubHost: "github.com",
        ghAccount: "octo-dev",
        rulePaths: [],
      });
      const rewritten: unknown = JSON.parse(await readFile(file, "utf8"));
      expect(rewritten).toMatchObject({
        label: "ACME renamed",
        repos: [{ repo: "patchdesk", localPath: "/workspace/patchdesk" }],
      });
      expect(rewritten).toMatchObject({ workspaceRoots: [] });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("choosing a watched repository's checkout", () => {
  it("saves the top-level of the chosen checkout for the workspace the request names", async () => {
    const root = await mkdtemp(`${tmpdir()}/patchdesk-choose-checkout-`);
    try {
      const checkout = await gitCheckout(
        root,
        "https://github.com/octo-org/new-repo.git",
      );
      await mkdir(join(checkout, "src"));
      const paths = PatchdeskPaths.forTest(join(root, "data"));
      const store = new ProfileStore(paths);
      await store.save(
        mustParse(
          parseWorkspaceProfileConfig({
            ...profile,
            repos: [
              ...profile.repos,
              { host: "github.com", owner: "octo-org", repo: "new-repo" },
            ],
          }),
        ),
      );
      const controller = new DashboardController(
        store,
        new FakeGitHubAdapter({}),
        git,
        paths,
      );

      const chosen = await controller.chooseWatchedRepoCheckout({
        profileId: "acme",
        host: "github.com",
        owner: "octo-org",
        repo: "new-repo",
        localPath: join(checkout, "src"),
      });

      expect(chosen).toMatchObject({ _tag: "ok" });
      expect(await store.load(profile.id)).toMatchObject({
        _tag: "ok",
        value: {
          repos: [
            { repo: "patchdesk", localPath: "/workspace/patchdesk" },
            { repo: "new-repo", localPath: await realpath(checkout) },
          ],
        },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    {
      name: "a checkout of another repository",
      origin: "https://github.com/octo-org/other.git",
      reason: "checkout_origin_mismatch",
    },
    {
      name: "a folder outside any checkout",
      origin: undefined,
      reason: "checkout_not_a_repository",
    },
  ])(
    "refuses $name and keeps the saved checkout",
    async ({ origin, reason }) => {
      const root = await mkdtemp(`${tmpdir()}/patchdesk-refuse-checkout-`);
      try {
        const folder =
          origin === undefined
            ? join(root, "plain")
            : await gitCheckout(root, origin);
        if (origin === undefined) await mkdir(folder);
        const paths = PatchdeskPaths.forTest(join(root, "data"));
        const store = new ProfileStore(paths);
        await store.save(profile);
        const controller = new DashboardController(
          store,
          new FakeGitHubAdapter({}),
          git,
          paths,
        );

        const chosen = await controller.chooseWatchedRepoCheckout({
          profileId: "acme",
          host: "github.com",
          owner: "octo-org",
          repo: "patchdesk",
          localPath: folder,
        });

        expect(chosen).toEqual({
          _tag: "err",
          error: { _tag: "DashboardControllerFailure", reason },
        });
        expect(await store.load(profile.id)).toMatchObject({
          _tag: "ok",
          value: {
            repos: [{ repo: "patchdesk", localPath: "/workspace/patchdesk" }],
          },
        });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});

/** A git checkout under `root` whose `origin` is `origin`. */
async function gitCheckout(root: string, origin: string): Promise<string> {
  const checkout = join(root, "checkout");
  execFileSync("git", ["init", "-q", checkout]);
  execFileSync("git", ["-C", checkout, "remote", "add", "origin", origin]);
  return checkout;
}
