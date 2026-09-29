import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { CommandRunner } from "../../src/adapters/github/command-runner";
import { createReadOnlyGitExecutor } from "../../src/main/local-api-stores";
import { parseLocalBranchName } from "../../src/domain/ids";
import {
  listLocalBranches,
  namedBaseRef,
  type LocalBranchListing,
} from "../../src/services/local-base-inference";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

/** Runs git for fixture setup only; the code under test runs git through the production executor. */
function git(cwd: string, ...args: ReadonlyArray<string>): string {
  return execFileSync(
    "git",
    [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    { cwd, encoding: "utf8" },
  ).trim();
}

/** A repository on `main` with one commit; the default branch is pinned so the maintainer's git config cannot decide it. */
async function repository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "patchdesk-base-inference-"));
  roots.push(root);
  const path = join(root, "repo");
  execFileSync("git", ["init", "-q", "-b", "main", path]);
  git(path, "config", "init.defaultBranch", "main");
  await commit(path, "root");
  return path;
}

async function commit(path: string, name: string): Promise<void> {
  await writeFile(join(path, `${name}.txt`), `${name}\n`);
  git(path, "add", `${name}.txt`);
  git(path, "commit", "-q", "-m", name);
}

function listed(path: string) {
  return listLocalBranches(
    createReadOnlyGitExecutor(new CommandRunner()),
    path,
  );
}

describe("listLocalBranches", () => {
  it("infers main for a feature branch off it, with the commits since the merge base", async () => {
    const path = await repository();
    git(path, "checkout", "-q", "-b", "feature");
    await commit(path, "one");
    await commit(path, "two");

    expect(await listed(path)).toEqual({
      _tag: "ok",
      value: {
        head: { kind: "branch", branch: "feature" },
        branches: ["main"],
        remoteBranches: [],
        defaultBranch: "main",
        inferred: { baseBranch: "main", commitsBack: 2 },
      },
    });
  });

  it("infers the parent of a stacked branch rather than main", async () => {
    const path = await repository();
    git(path, "checkout", "-q", "-b", "parent");
    await commit(path, "parent");
    git(path, "checkout", "-q", "-b", "child");
    await commit(path, "child");

    const result = await listed(path);

    expect(result).toMatchObject({
      _tag: "ok",
      value: { inferred: { baseBranch: "parent", commitsBack: 1 } },
    });
  });

  it("breaks a tie toward the default branch origin/HEAD names, over a more recent or earlier-sorted one", async () => {
    const path = await repository();
    git(path, "branch", "trunk");
    git(path, "branch", "alpha");
    git(
      path,
      "symbolic-ref",
      "refs/remotes/origin/HEAD",
      "refs/remotes/origin/trunk",
    );
    git(path, "checkout", "-q", "-b", "feature");
    await commit(path, "feature");

    const result = await listed(path);

    expect(result).toMatchObject({
      _tag: "ok",
      value: {
        defaultBranch: "trunk",
        inferred: { baseBranch: "trunk", commitsBack: 1 },
      },
    });
  });

  it("infers nothing when every other branch is at or ahead of HEAD, and still lists them", async () => {
    const path = await repository();
    git(path, "branch", "same-tip");
    await commit(path, "ahead");
    git(path, "branch", "ahead");
    git(path, "reset", "-q", "--hard", "HEAD~1");

    const result = await listed(path);

    expect(result).toEqual({
      _tag: "ok",
      value: {
        head: { kind: "branch", branch: "main" },
        branches: expect.arrayContaining(["same-tip", "ahead"]),
        remoteBranches: [],
        defaultBranch: "main",
      },
    });
  });

  it("lists every local branch as a base candidate on a detached HEAD", async () => {
    const path = await repository();
    await commit(path, "detached");
    git(path, "checkout", "-q", "--detach");

    const result = await listed(path);

    expect(result).toMatchObject({
      _tag: "ok",
      value: {
        head: { kind: "detached" },
        branches: ["main"],
      },
    });
    expect(result._tag === "ok" && result.value.inferred).toBeUndefined();
  });

  it("lists remote-tracking branches without origin/HEAD and infers a local base even when a remote one is nearer (#591)", async () => {
    const path = await repository();
    git(path, "checkout", "-q", "-b", "feature");
    await commit(path, "one");
    await commit(path, "two");
    git(path, "update-ref", "refs/remotes/origin/feature", "HEAD~1");
    git(path, "update-ref", "refs/remotes/origin/main", "main");
    git(
      path,
      "symbolic-ref",
      "refs/remotes/origin/HEAD",
      "refs/remotes/origin/main",
    );

    const result = await listed(path);

    expect(result).toMatchObject({
      _tag: "ok",
      value: {
        branches: ["main"],
        remoteBranches: expect.arrayContaining([
          "origin/feature",
          "origin/main",
        ]),
        inferred: { baseBranch: "main", commitsBack: 2 },
      },
    });
    expect(result._tag === "ok" && result.value.remoteBranches).toHaveLength(2);
  });
});

describe("namedBaseRef", () => {
  /** On `feature`, with a local `main` and the remote-tracking `origin/main` and `origin/develop`. */
  const listing: LocalBranchListing = {
    head: { kind: "branch", branch: branch("feature") },
    branches: [branch("main")],
    remoteBranches: ["origin/main", "origin/develop"],
  };

  it.each([
    ["a local branch", "main", "refs/heads/main"],
    ["the branch HEAD names", "feature", "refs/heads/feature"],
    [
      "a remote-tracking branch",
      "origin/develop",
      "refs/remotes/origin/develop",
    ],
    [
      "a full ref, as written",
      "refs/remotes/origin/main",
      "refs/remotes/origin/main",
    ],
    ["a name the checkout does not have", "gone", undefined],
  ])("resolves %s", (_case, name, expected) => {
    expect(namedBaseRef(listing, branch(name))).toBe(expected);
  });

  it("prefers a local branch over the remote-tracking branch of the same name, as git does", () => {
    const shadowed: LocalBranchListing = {
      ...listing,
      branches: [branch("origin/main")],
    };

    expect(namedBaseRef(shadowed, branch("origin/main"))).toBe(
      "refs/heads/origin/main",
    );
  });
});

function branch(name: string) {
  const parsed = parseLocalBranchName(name);
  if (parsed._tag === "err") throw new Error(`invalid branch ${name}`);
  return parsed.value;
}
