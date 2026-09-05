import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { bumpCask } from "../../scripts/bump-cask-lib.mjs";

type CommandResult = {
  readonly status: number | null;
  readonly signal: string | null;
  readonly stdout: string;
  readonly stderr: string;
};

const roots: string[] = [];
afterEach(
  async () =>
    await Promise.all(
      roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    ),
);

const OLD_SHA = "f".repeat(64);
const CASK = `cask "patchdesk" do
  version "0.1.0"
  sha256 "${OLD_SHA}"

  url "https://github.com/kwanpham2195/patchdesk/releases/download/v#{version}/Patchdesk-#{version}-arm64.dmg"
  name "Patchdesk"

  app "Patchdesk.app"
end
`;
const DMG_BYTES = Buffer.from("not really a disk image");
const DMG_SHA = createHash("sha256").update(DMG_BYTES).digest("hex");

describe("bumpCask", () => {
  it("rewrites the version and sha256 lines, leaves the rest alone, and prints the shipping commands", async () => {
    const fixture = await createFixture();
    const output = captureOutput();
    const exitCode = await bumpCask({
      args: ["0.2.0"],
      projectRoot: fixture.projectRoot,
      run: fixture.run,
      output,
      env: fixture.env,
    });

    expect(exitCode).toBe(0);
    expect(await fixture.readCask()).toBe(
      CASK.replace('version "0.1.0"', 'version "0.2.0"').replace(
        OLD_SHA,
        DMG_SHA,
      ),
    );
    const stdout = output.stdoutText();
    expect(stdout).toContain(`in ${fixture.tapDir}:`);
    expect(stdout).toContain("git add Casks/patchdesk.rb");
    expect(stdout).toContain('git commit -m "Bump patchdesk to 0.2.0"');
    expect(stdout).toContain("git push origin main");
    expect(stdout).toContain(
      "brew update && brew audit --cask kwanpham2195/patchdesk/patchdesk && brew upgrade --cask patchdesk",
    );
    expect(fixture.commands()).not.toContainEqual(
      expect.objectContaining({ command: "brew" }),
    );
  });

  it("asks brew for the tap directory when PATCHDESK_TAP_DIR is unset", async () => {
    const fixture = await createFixture();
    const output = captureOutput();
    const exitCode = await bumpCask({
      args: ["0.2.0"],
      projectRoot: fixture.projectRoot,
      run: fixture.run,
      output,
      env: {},
    });

    expect(exitCode).toBe(0);
    expect(fixture.commands()).toContainEqual({
      command: "brew",
      args: ["--repository", "kwanpham2195/patchdesk"],
    });
    expect(await fixture.readCask()).toContain('version "0.2.0"');
  });

  it("refuses a missing or malformed version argument", async () => {
    const fixture = await createFixture();
    const output = captureOutput();
    for (const args of [[], ["v0.2.0"], ["0.2"], ["0.2.0", "0.3.0"]]) {
      expect(
        await bumpCask({
          args,
          projectRoot: fixture.projectRoot,
          run: fixture.run,
          output,
          env: fixture.env,
        }),
      ).toBe(1);
    }
    expect(output.stderrText()).toContain("pnpm release:cask 0.2.0");
    expect(await fixture.readCask()).toBe(CASK);
  });

  it("refuses a dirty tap and leaves the cask alone", async () => {
    const fixture = await createFixture({
      status: {
        status: 0,
        signal: null,
        stdout: " M Casks/patchdesk.rb\n",
        stderr: "",
      },
    });
    const output = captureOutput();
    const exitCode = await bumpCask({
      args: ["0.2.0"],
      projectRoot: fixture.projectRoot,
      run: fixture.run,
      output,
      env: fixture.env,
    });

    expect(exitCode).toBe(1);
    expect(output.stderrText()).toContain("uncommitted changes");
    expect(await fixture.readCask()).toBe(CASK);
  });

  it("refuses a draft release and says why it cannot be installed", async () => {
    const fixture = await createFixture({
      release: { status: 0, signal: null, stdout: "true\n", stderr: "" },
    });
    const output = captureOutput();
    const exitCode = await bumpCask({
      args: ["0.2.0"],
      projectRoot: fixture.projectRoot,
      run: fixture.run,
      output,
      env: fixture.env,
    });

    expect(exitCode).toBe(1);
    expect(output.stderrText()).toContain("still a draft");
    expect(output.stderrText()).toContain("cannot be installed");
    expect(await fixture.readCask()).toBe(CASK);
  });

  it("refuses a release GitHub does not have", async () => {
    const fixture = await createFixture({
      release: {
        status: 1,
        signal: null,
        stdout: "",
        stderr: "release not found\n",
      },
    });
    const output = captureOutput();
    const exitCode = await bumpCask({
      args: ["0.2.0"],
      projectRoot: fixture.projectRoot,
      run: fixture.run,
      output,
      env: fixture.env,
    });

    expect(exitCode).toBe(1);
    expect(output.stderrText()).toContain("GitHub has no release v0.2.0");
    expect(output.stderrText()).toContain("release not found");
    expect(await fixture.readCask()).toBe(CASK);
  });

  it("refuses when the DMG has not been built", async () => {
    const fixture = await createFixture();
    const output = captureOutput();
    const exitCode = await bumpCask({
      args: ["0.3.0"],
      projectRoot: fixture.projectRoot,
      run: fixture.run,
      output,
      env: fixture.env,
    });

    expect(exitCode).toBe(1);
    expect(output.stderrText()).toContain("Patchdesk-0.3.0-arm64.dmg");
    expect(output.stderrText()).toContain("pnpm package:mac");
    expect(await fixture.readCask()).toBe(CASK);
  });

  it("refuses a cask with no version line", async () => {
    const fixture = await createFixture();
    const withoutVersion = CASK.replace('  version "0.1.0"\n', "");
    await writeFile(fixture.caskPath, withoutVersion);
    const output = captureOutput();
    const exitCode = await bumpCask({
      args: ["0.2.0"],
      projectRoot: fixture.projectRoot,
      run: fixture.run,
      output,
      env: fixture.env,
    });

    expect(exitCode).toBe(1);
    expect(output.stderrText()).toContain('exactly one `version "..."` line');
    expect(await fixture.readCask()).toBe(withoutVersion);
  });

  it("refuses a tap that is not checked out", async () => {
    const fixture = await createFixture();
    const output = captureOutput();
    const exitCode = await bumpCask({
      args: ["0.2.0"],
      projectRoot: fixture.projectRoot,
      run: fixture.run,
      output,
      env: { PATCHDESK_TAP_DIR: join(fixture.tapDir, "missing") },
    });

    expect(exitCode).toBe(1);
    expect(output.stderrText()).toContain("brew tap kwanpham2195/patchdesk");
  });
});

async function createFixture(
  results: {
    readonly status?: CommandResult;
    readonly release?: CommandResult;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "patchdesk-cask-"));
  roots.push(root);
  const projectRoot = join(root, "project");
  const tapDir = join(root, "tap");
  const caskPath = join(tapDir, "Casks", "patchdesk.rb");
  await Promise.all([
    mkdir(join(projectRoot, "release"), { recursive: true }),
    mkdir(join(tapDir, "Casks"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(
      join(projectRoot, "release", "Patchdesk-0.2.0-arm64.dmg"),
      DMG_BYTES,
    ),
    writeFile(caskPath, CASK),
  ]);
  const clean: CommandResult = {
    status: 0,
    signal: null,
    stdout: "",
    stderr: "",
  };
  const published: CommandResult = { ...clean, stdout: "false\n" };
  const commands: { command: string; args: ReadonlyArray<string> }[] = [];
  return {
    projectRoot,
    tapDir,
    caskPath,
    env: { PATCHDESK_TAP_DIR: tapDir },
    commands: () => commands,
    run: async (command: string, args: ReadonlyArray<string>) => {
      commands.push({ command, args });
      if (command === "brew") return { ...clean, stdout: `${tapDir}\n` };
      if (command === "gh") return results.release ?? published;
      return results.status ?? clean;
    },
    readCask: async () => await readFile(caskPath, "utf8"),
  };
}

function captureOutput() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout: (text: string) => stdout.push(text),
    stderr: (text: string) => stderr.push(text),
    stdoutText: () => stdout.join(""),
    stderrText: () => stderr.join(""),
  };
}
