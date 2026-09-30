import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  CommandRunner,
  type CommandExecution,
} from "../../src/adapters/github/command-runner";
import { FakeGitHubAdapter } from "../../src/adapters/github/github-adapter";
import { PatchdeskPaths } from "../../src/adapters/storage/patchdesk-paths";
import { ProfileStore } from "../../src/adapters/storage/profile-store";
import { parseAbsolutePath, type AbsolutePath } from "../../src/domain/ids";
import { parseWorkspaceProfileConfig } from "../../src/domain/workspace-profile";
import { createReadOnlyGitExecutor } from "../../src/main/local-api-stores";
import { DashboardController } from "../../src/services/dashboard-controller";
import type { GitHubEnvironmentSnapshot } from "../../src/services/github-environment-probe";
import { WorkspaceSetupService } from "../../src/services/workspace-setup-service";

const git = createReadOnlyGitExecutor(new CommandRunner());

const signedIn: CommandExecution = {
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

const environment: GitHubEnvironmentSnapshot = {
  git: "ready",
  gh: "ready",
  githubAuth: "ready",
  githubAccounts: [{ host: "github.com", login: "octocat", active: true }],
};

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

function absolute(path: string): AbsolutePath {
  const parsed = parseAbsolutePath(path);
  if (parsed._tag === "err") throw new Error(`not absolute: ${path}`);
  return parsed.value;
}

/** A checkout of `octo-org/patchdesk` with a `src` folder, and a setup service over a fresh store. */
async function setUp(gh: CommandExecution = signedIn) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pd-setup-")));
  roots.push(root);
  const checkout = join(root, "patchdesk");
  execFileSync("git", ["init", "-q", "-b", "main", checkout]);
  execFileSync("git", [
    "-C",
    checkout,
    "remote",
    "add",
    "origin",
    "git@github.com:octo-org/patchdesk.git",
  ]);
  await mkdir(join(checkout, "src"));
  const paths = PatchdeskPaths.forTest(join(root, "app"));
  const store = new ProfileStore(paths);
  const commands = new CommandRunner({
    execute: () => Promise.resolve(gh),
  });
  const setup = new WorkspaceSetupService({
    dashboard: new DashboardController(
      store,
      new FakeGitHubAdapter({}),
      git,
      paths,
      commands,
    ),
    git,
    commands,
    environment: { read: () => Promise.resolve(environment) },
  });
  return { root, checkout, store, setup };
}

describe("WorkspaceSetupService", () => {
  it("creates the Default workspace from the active gh account and watches the checkout's repository", async () => {
    const { checkout, store, setup } = await setUp();

    const added = await setup.addRepository(absolute(join(checkout, "src")));

    expect(added).toMatchObject({
      _tag: "ok",
      value: {
        profile: { id: "default", ghAccount: "octocat" },
        profileCreated: true,
        repositoryAdded: true,
        repository: { owner: "octo-org", repo: "patchdesk" },
        localPath: checkout,
      },
    });
    expect(await store.loadConfig()).toMatchObject({
      value: { lastSelectedProfileId: "default" },
    });
    expect(await setup.status()).toMatchObject({
      value: {
        profile: { id: "default" },
        repositories: [
          { repo: "patchdesk", localPath: checkout, checkout: "chosen" },
        ],
      },
    });
  });

  it("saves nothing when no gh account is signed in", async () => {
    const { checkout, store, setup } = await setUp({ _tag: "Unavailable" });

    expect(await setup.addRepository(absolute(checkout))).toEqual({
      _tag: "err",
      error: { reason: "no_github_account" },
    });
    expect(await store.list()).toEqual({ _tag: "ok", value: [] });
  });

  it("moves a watched repository to the checkout it was moved to", async () => {
    const { root, checkout, store, setup } = await setUp();
    const saved = parseWorkspaceProfileConfig({
      id: "acme",
      label: "ACME",
      githubHost: "github.com",
      ghAccount: "octocat",
      rulePaths: [],
      repos: [
        {
          host: "github.com",
          owner: "octo-org",
          repo: "patchdesk",
          localPath: checkout,
        },
      ],
    });
    if (saved._tag === "err") throw new Error("Invalid profile fixture");
    await store.save(saved.value);
    const moved = join(root, "moved");
    await rename(checkout, moved);

    expect(await setup.status()).toMatchObject({
      value: { repositories: [{ checkout: "missing" }] },
    });
    expect(await setup.setCheckout(absolute(moved))).toMatchObject({
      _tag: "ok",
      value: {
        profileCreated: false,
        repositoryAdded: false,
        localPath: moved,
      },
    });
    expect(await store.load(saved.value.id)).toMatchObject({
      value: { repos: [{ repo: "patchdesk", localPath: moved }] },
    });
  });

  it("refuses a checkout of an unwatched repository or one with no GitHub origin", async () => {
    const { root, checkout, setup } = await setUp();
    await setup.addRepository(absolute(checkout));
    const other = join(root, "other");
    execFileSync("git", ["init", "-q", other]);

    expect(await setup.setCheckout(absolute(other))).toEqual({
      _tag: "err",
      error: { reason: "checkout_no_github_origin" },
    });
    execFileSync("git", [
      "-C",
      other,
      "remote",
      "add",
      "origin",
      "https://github.com/octo-org/other.git",
    ]);
    expect(await setup.setCheckout(absolute(other))).toEqual({
      _tag: "err",
      error: { reason: "not_watched" },
    });
  });
});
