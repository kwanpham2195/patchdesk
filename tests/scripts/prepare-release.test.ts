import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { prepareRelease } from "../../scripts/prepare-release-lib.mjs";

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

const PACKAGE_JSON = `{
  "name": "patchdesk",
  "version": "0.1.0",
  "private": true,
  "dependencies": {
    "hono": "^4.13.2"
  }
}
`;

const CHANGELOG = `# Changelog

## Unreleased

- Added a disk image to the macOS download.

## Older notes

- Something that already shipped.
`;

describe("prepareRelease", () => {
  it("sets the version, closes the Unreleased section, and prints the publishing commands", async () => {
    const fixture = await createFixture();
    const output = captureOutput();
    const exitCode = await prepareRelease({
      args: ["0.2.0"],
      projectRoot: fixture.projectRoot,
      today: new Date(2026, 7, 30),
      run: fixture.run,
      output,
    });

    expect(exitCode).toBe(0);
    expect(await fixture.readPackage()).toContain('"version": "0.2.0"');
    expect(await fixture.readPackage()).toContain('"hono": "^4.13.2"');
    const changelog = await fixture.readChangelog();
    expect(changelog).toContain(
      "## Unreleased\n\n## 0.2.0 - 2026-08-30\n\n- Added a disk image",
    );
    expect(output.stdoutText()).toContain("git tag v0.2.0");
    expect(output.stdoutText()).toContain("git push origin main v0.2.0");
  });

  it("refuses a dirty working tree and leaves both files alone", async () => {
    const fixture = await createFixture({
      status: {
        status: 0,
        signal: null,
        stdout: " M src/app.ts\n",
        stderr: "",
      },
    });
    const output = captureOutput();
    const exitCode = await prepareRelease({
      args: ["0.2.0"],
      projectRoot: fixture.projectRoot,
      today: new Date(2026, 7, 30),
      run: fixture.run,
      output,
    });

    expect(exitCode).toBe(1);
    expect(output.stderrText()).toContain("uncommitted changes");
    expect(await fixture.readPackage()).toBe(PACKAGE_JSON);
    expect(await fixture.readChangelog()).toBe(CHANGELOG);
  });

  it("refuses a version whose tag already exists", async () => {
    const fixture = await createFixture({
      tag: { status: 0, signal: null, stdout: "v0.2.0\n", stderr: "" },
    });
    const output = captureOutput();
    const exitCode = await prepareRelease({
      args: ["0.2.0"],
      projectRoot: fixture.projectRoot,
      today: new Date(2026, 7, 30),
      run: fixture.run,
      output,
    });

    expect(exitCode).toBe(1);
    expect(output.stderrText()).toContain("Tag v0.2.0 already exists");
    expect(await fixture.readPackage()).toBe(PACKAGE_JSON);
  });

  it("refuses an argument that is not a release version", async () => {
    const fixture = await createFixture();
    const output = captureOutput();
    for (const args of [[], ["v0.2.0"], ["0.2"], ["0.2.0", "0.3.0"]]) {
      expect(
        await prepareRelease({
          args,
          projectRoot: fixture.projectRoot,
          today: new Date(2026, 7, 30),
          run: fixture.run,
          output,
        }),
      ).toBe(2);
    }
    expect(output.stderrText()).toContain("pnpm release:prepare 0.2.0");
    expect(await fixture.readPackage()).toBe(PACKAGE_JSON);
  });

  it("refuses a changelog with no Unreleased section, before writing the version", async () => {
    const fixture = await createFixture();
    await writeFile(
      join(fixture.projectRoot, "CHANGELOG.md"),
      "# Changelog\n\n## 0.1.0 - 2026-08-01\n",
    );
    const output = captureOutput();
    const exitCode = await prepareRelease({
      args: ["0.2.0"],
      projectRoot: fixture.projectRoot,
      today: new Date(2026, 7, 30),
      run: fixture.run,
      output,
    });

    expect(exitCode).toBe(1);
    expect(output.stderrText()).toContain("## Unreleased");
    expect(await fixture.readPackage()).toBe(PACKAGE_JSON);
  });
});

async function createFixture(
  results: {
    readonly status?: CommandResult;
    readonly tag?: CommandResult;
  } = {},
) {
  const projectRoot = await mkdtemp(join(tmpdir(), "patchdesk-release-"));
  roots.push(projectRoot);
  await Promise.all([
    writeFile(join(projectRoot, "package.json"), PACKAGE_JSON),
    writeFile(join(projectRoot, "CHANGELOG.md"), CHANGELOG),
  ]);
  const clean: CommandResult = {
    status: 0,
    signal: null,
    stdout: "",
    stderr: "",
  };
  return {
    projectRoot,
    run: async (_command: string, args: ReadonlyArray<string>) =>
      args[0] === "status" ? (results.status ?? clean) : (results.tag ?? clean),
    readPackage: async () =>
      await readFile(join(projectRoot, "package.json"), "utf8"),
    readChangelog: async () =>
      await readFile(join(projectRoot, "CHANGELOG.md"), "utf8"),
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
