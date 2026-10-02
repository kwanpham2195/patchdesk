import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { copyInstalledProfileToDev } from "../../scripts/dev-copy-profile-lib.mjs";

let home: string;
const installed = () => join(home, ".config", "patchdesk");
const development = () => join(home, ".config", "patchdesk-dev");

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "pd-copy-profile-"));
  await mkdir(join(installed(), "profiles"), { recursive: true });
  await writeFile(join(installed(), "config.json"), '{"from":"installed"}');
  await writeFile(join(installed(), "profiles", "work.json"), "{}");
  await writeFile(join(installed(), "window-state.json"), "{}");
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

async function run(args: ReadonlyArray<string>) {
  const stderr: string[] = [];
  const status = await copyInstalledProfileToDev({
    args,
    homeDirectory: home,
    output: { stdout: () => undefined, stderr: (text) => stderr.push(text) },
  });
  return { status, stderr: stderr.join("") };
}

describe("dev:copy-profile", () => {
  it("copies config.json and the profiles, and nothing else", async () => {
    expect((await run([])).status).toBe(0);

    expect(await readFile(join(development(), "config.json"), "utf8")).toBe(
      '{"from":"installed"}',
    );
    expect(await readdir(join(development(), "profiles"))).toEqual([
      "work.json",
    ]);
    expect((await readdir(development())).sort()).toEqual([
      "config.json",
      "profiles",
    ]);
  });

  it("refuses an existing dev config without --force, and replaces it with --force", async () => {
    await mkdir(development(), { recursive: true });
    await writeFile(join(development(), "config.json"), '{"from":"dev"}');
    await mkdir(join(development(), "profiles"), { recursive: true });
    await writeFile(join(development(), "profiles", "dev-only.json"), "{}");

    const refused = await run([]);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain("--force");
    expect(await readFile(join(development(), "config.json"), "utf8")).toBe(
      '{"from":"dev"}',
    );

    expect((await run(["--force"])).status).toBe(0);
    expect(await readdir(join(development(), "profiles"))).toEqual([
      "work.json",
    ]);
    expect(await readFile(join(development(), "config.json"), "utf8")).toBe(
      '{"from":"installed"}',
    );
  });
});
