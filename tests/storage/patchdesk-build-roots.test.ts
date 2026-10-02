import { homedir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { PatchdeskPaths } from "../../src/adapters/storage/patchdesk-paths";

const home = homedir();

function rootsOf(paths: PatchdeskPaths): ReadonlyArray<string> {
  return [
    paths.configDirectory(),
    paths.dataDirectory(),
    paths.cacheDirectory(),
  ];
}

describe("PatchdeskPaths.forBuild", () => {
  it("gives a packaged build the installed app's roots", () => {
    const paths = PatchdeskPaths.forBuild({ packaged: true, environment: {} });

    expect(rootsOf(paths)).toEqual([
      join(home, ".config", "patchdesk"),
      join(home, ".local", "share", "patchdesk"),
      join(home, ".cache", "patchdesk"),
    ]);
    expect(paths.mcpSocketFile()).toBe(
      join(home, ".local", "share", "patchdesk", "mcp", "patchdesk.sock"),
    );
  });

  it("gives an unpackaged build its own -dev roots", () => {
    const paths = PatchdeskPaths.forBuild({ packaged: false, environment: {} });

    expect(rootsOf(paths)).toEqual([
      join(home, ".config", "patchdesk-dev"),
      join(home, ".local", "share", "patchdesk-dev"),
      join(home, ".cache", "patchdesk-dev"),
    ]);
    expect(paths.appUpdateStateFile()).toBe(
      join(home, ".config", "patchdesk-dev", "app-update.json"),
    );
  });

  it("shares the installed roots when PATCHDESK_DEV_SHARED=1, with a socket of its own", () => {
    const paths = PatchdeskPaths.forBuild({
      packaged: false,
      environment: { PATCHDESK_DEV_SHARED: "1" },
    });

    expect(rootsOf(paths)).toEqual(
      rootsOf(PatchdeskPaths.forBuild({ packaged: true, environment: {} })),
    );
    expect(paths.mcpSocketFile()).toBe(
      join(home, ".local", "share", "patchdesk", "mcp", "patchdesk-dev.sock"),
    );
  });

  it("ignores PATCHDESK_DEV_SHARED in a packaged build", () => {
    const paths = PatchdeskPaths.forBuild({
      packaged: true,
      environment: { PATCHDESK_DEV_SHARED: "1" },
    });

    expect(paths.mcpSocketFile()).toContain("patchdesk.sock");
  });
});

describe("PatchdeskPaths.fromEnvironment", () => {
  it("rebuilds the roots the app passed to a child process", () => {
    const parent = PatchdeskPaths.forBuild({
      packaged: false,
      environment: {},
    });

    const child = PatchdeskPaths.fromEnvironment(parent.rootsEnvironment());

    expect(rootsOf(child)).toEqual(rootsOf(parent));
  });

  it("falls back to the installed roots when none were passed", () => {
    expect(rootsOf(PatchdeskPaths.fromEnvironment({}))).toEqual(
      rootsOf(PatchdeskPaths.forBuild({ packaged: true, environment: {} })),
    );
  });
});
