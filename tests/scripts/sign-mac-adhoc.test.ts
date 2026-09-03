import { describe, expect, it } from "vitest";

import { adhocSignPackagedApp } from "../../scripts/sign-mac-adhoc-lib.mjs";

type Invocation = {
  command: string;
  args: ReadonlyArray<string>;
  cwd: string;
};

function harness(status: number | null = 0, stderr = "") {
  const invocations: Invocation[] = [];
  const stdout: string[] = [];
  const stderrLines: string[] = [];
  return {
    invocations,
    stdout,
    stderrLines,
    options: {
      appOutDir: "/build/release/mac-arm64",
      productFilename: "Patchdesk",
      cwd: "/build",
      run: async (
        command: string,
        args: ReadonlyArray<string>,
        cwd: string,
      ) => {
        invocations.push({ command, args, cwd });
        return { status, signal: null, stdout: "", stderr };
      },
      output: {
        stdout: (text: string) => stdout.push(text),
        stderr: (text: string) => stderrLines.push(text),
      },
    },
  };
}

describe("adhocSignPackagedApp", () => {
  it("ad-hoc signs the whole bundle when the build is unsigned", async () => {
    const { invocations, options, stdout } = harness();

    const outcome = await adhocSignPackagedApp({
      ...options,
      electronPlatformName: "darwin",
      environment: { PATH: "/usr/bin" },
    });

    expect(outcome.signed).toBe(true);
    expect(invocations).toEqual([
      {
        command: "codesign",
        // "-" is the ad-hoc identity: it seals the bundle without a
        // certificate so the app runs once the quarantine flag is cleared;
        // it does not get past Gatekeeper.
        args: [
          "--force",
          "--deep",
          "--sign",
          "-",
          "/build/release/mac-arm64/Patchdesk.app",
        ],
        cwd: "/build",
      },
    ]);
    expect(stdout.join("")).toContain("Ad-hoc signed");
  });

  it("stands down when a Developer ID certificate signs the build", async () => {
    const { invocations, options } = harness();

    const outcome = await adhocSignPackagedApp({
      ...options,
      electronPlatformName: "darwin",
      environment: { CSC_LINK: "base64-certificate" },
    });

    // electron-builder signs and notarizes this build itself; an ad-hoc
    // signature laid over that would replace a real one with an anonymous one.
    expect(outcome.signed).toBe(false);
    expect(outcome.reason).toContain("CSC_LINK is set");
    expect(invocations).toEqual([]);
  });

  it("reads an unconfigured CSC_LINK secret as unsigned, like the packaging script does", async () => {
    const { invocations, options } = harness();

    const outcome = await adhocSignPackagedApp({
      ...options,
      electronPlatformName: "darwin",
      environment: { CSC_LINK: "" },
    });

    expect(outcome.signed).toBe(true);
    expect(invocations).toHaveLength(1);
  });

  it("does nothing on a build that is not macOS", async () => {
    const { invocations, options } = harness();

    const outcome = await adhocSignPackagedApp({
      ...options,
      electronPlatformName: "win32",
      environment: { PATH: "/usr/bin" },
    });

    expect(outcome.signed).toBe(false);
    expect(outcome.reason).toContain("not a macOS build");
    expect(invocations).toEqual([]);
  });

  it("fails the build when codesign fails", async () => {
    const { options } = harness(1, "bundle format unrecognized");

    await expect(
      adhocSignPackagedApp({
        ...options,
        electronPlatformName: "darwin",
        environment: { PATH: "/usr/bin" },
      }),
    ).rejects.toThrow("bundle format unrecognized");
  });
});
