import { execFileSync } from "node:child_process";

import { afterEach, describe, expect, it } from "vitest";

import { ProfileStore } from "../../src/adapters/storage/profile-store";
import { describeStatus, runSetupCommand } from "../../src/mcp/setup-cli";
import {
  startAppWithLinkedWorktree,
  type McpAppFixture,
} from "../main/mcp-app-fixture";

let app: McpAppFixture | undefined;

afterEach(async () => {
  await app?.stop();
  app = undefined;
});

async function run(socketPath: string, args: ReadonlyArray<string>) {
  let out = "";
  const reported: string[] = [];
  const exitCode = await runSetupCommand(args, {
    socketPath,
    cwd: "/",
    out: (text) => (out += text),
    report: (line) => reported.push(line),
  });
  return { exitCode, out, reported };
}

describe("patchdesk setup", () => {
  it("sets a watched repository's checkout through the running app", async () => {
    app = await startAppWithLinkedWorktree();
    execFileSync("git", [
      "-C",
      app.repositoryPath,
      "remote",
      "add",
      "origin",
      "https://github.com/octo-org/patchdesk.git",
    ]);

    const set = await run(app.socketPath, [
      "set-checkout",
      "--cwd",
      app.linkedPath,
    ]);

    expect(set).toEqual({
      exitCode: 0,
      out: `The ACME workspace already watches octo-org/patchdesk.\nCheckout: ${app.linkedPath}\n`,
      reported: [],
    });
    expect(await new ProfileStore(app.paths).list()).toMatchObject({
      value: [
        {
          repos: [
            { repo: "patchdesk", localPath: app.linkedPath },
            { repo: "remote-only" },
          ],
        },
      ],
    });
  });

  it("reports a refusal and exits 1, and leaves unknown arguments to the usage text", async () => {
    app = await startAppWithLinkedWorktree();

    expect(await run(app.socketPath, ["add-repo", "--cwd", "/"])).toMatchObject(
      {
        exitCode: 1,
        reported: [expect.stringMatching(/^checkout_not_a_repository: /)],
      },
    );
    expect((await run(app.socketPath, ["remove-repo"])).exitCode).toBe(
      undefined,
    );
  });

  it("lists the steps left in the status text", () => {
    const text = describeStatus({
      git: "ready",
      gh: "ready",
      githubAuth: "authentication_required",
      githubAccounts: [],
      repositories: [],
    });

    expect(text).toContain("Workspace: none");
    expect(text).toContain("  - The user runs gh auth login.");
    expect(text).toContain(
      "  - Run patchdesk setup add-repo in a checkout of a repository to review.",
    );
  });
});
