import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { decideReactDoctor } from "#scripts/precommit.mjs";

const fixtures: string[] = [];
afterEach(async () => {
  for (const path of fixtures.splice(0))
    await rm(path, { recursive: true, force: true });
});

async function hookFixture(staged: string, differs: boolean) {
  const cwd = await realpath(
    await mkdtemp(join(tmpdir(), "patchdesk-precommit-")),
  );
  fixtures.push(cwd);
  execFileSync("git", ["init", "--quiet", cwd]);
  execFileSync("git", ["config", "user.name", "Fixture"], { cwd });
  execFileSync("git", ["config", "user.email", "fixture@example.com"], { cwd });
  execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd });
  execFileSync("git", ["config", "core.hooksPath", ".git/hooks"], { cwd });
  await writeFile(join(cwd, "package.json"), '{"name":"fixture"}\n');
  execFileSync("git", ["add", "package.json"], { cwd });
  execFileSync("git", ["commit", "--quiet", "-m", "initial"], { cwd });
  await mkdir(join(cwd, "scripts"));
  for (const name of [
    "precommit.mjs",
    "gate-command-lib.mjs",
    "run-full-check.mjs",
    "full-check-lock.mjs",
  ])
    await copyFile(
      join(process.cwd(), "scripts", name),
      join(cwd, "scripts", name),
    );
  await mkdir(join(cwd, "bin"));
  await writeFile(
    join(cwd, "bin/pnpm"),
    `#!${process.execPath}\nconst fs = require('node:fs'); const args = process.argv.slice(2).join(' '); fs.appendFileSync(process.env.RECEIPT, args + '\\n'); console.log('fixture ' + args); process.exit(args === process.env.FAIL_COMMAND ? 8 : 0);\n`,
    { mode: 0o755 },
  );
  await writeFile(
    join(cwd, ".git/hooks/pre-commit"),
    `#!/bin/sh\nexec "${process.execPath}" "${join(cwd, "scripts/precommit.mjs")}"\n`,
    { mode: 0o755 },
  );
  if (staged.startsWith("src/"))
    await mkdir(join(cwd, "src/renderer"), { recursive: true });
  await writeFile(join(cwd, staged), "fixture\n");
  execFileSync("git", ["add", staged], { cwd });
  if (differs)
    await writeFile(join(cwd, "package.json"), '{"name":"unstaged"}\n');
  return cwd;
}

describe("precommit process", () => {
  it.each([
    {
      path: "README.md",
      differs: false,
      failure: "",
      status: 0,
      commands: ["lint:staged", "exec oxfmt --check README.md"],
    },
    {
      path: "README.md",
      differs: false,
      failure: "lint:staged",
      status: 1,
      commands: ["lint:staged"],
    },
    {
      path: "src/renderer/app.tsx",
      differs: false,
      failure: "",
      status: 0,
      commands: [
        "lint:staged",
        "typecheck",
        "check:imports",
        "check:error-ui",
        "knip:ratchet",
        "exec vitest --run tests/scripts/context-budget.test.ts",
        "exec vitest related --run --passWithNoTests src/renderer/app.tsx",
        "exec react-doctor --staged --blocking warning --yes",
      ],
    },
    {
      path: "src/renderer/app.tsx",
      differs: true,
      failure: "",
      status: 1,
      commands: [
        "lint:staged",
        "typecheck",
        "check:imports",
        "check:error-ui",
        "knip:ratchet",
        "exec vitest --run tests/scripts/context-budget.test.ts",
        "exec vitest related --run --passWithNoTests src/renderer/app.tsx",
      ],
    },
    {
      path: "src/app.mjs",
      differs: true,
      failure: "",
      status: 0,
      commands: [
        "lint:staged",
        "typecheck",
        "check:imports",
        "knip:ratchet",
        "exec vitest --run tests/scripts/context-budget.test.ts",
        "exec vitest related --run --passWithNoTests src/app.mjs",
      ],
    },
    {
      path: "src/renderer/app.tsx",
      differs: false,
      failure: "typecheck",
      status: 1,
      commands: ["lint:staged", "typecheck"],
    },
    {
      path: "src/renderer/app.tsx",
      differs: false,
      failure: "exec react-doctor --staged --blocking warning --yes",
      status: 1,
      commands: [
        "lint:staged",
        "typecheck",
        "check:imports",
        "check:error-ui",
        "knip:ratchet",
        "exec vitest --run tests/scripts/context-budget.test.ts",
        "exec vitest related --run --passWithNoTests src/renderer/app.tsx",
        "exec react-doctor --staged --blocking warning --yes",
      ],
    },
  ])(
    "gates a real commit for $path, differs=$differs, failure=$failure",
    async (scenario) => {
      const cwd = await hookFixture(scenario.path, scenario.differs);
      const receipt = join(cwd, "commands.txt");
      const result = spawnSync("git", ["commit", "-m", "checked fixture"], {
        cwd,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${join(cwd, "bin")}:${process.env.PATH}`,
          RECEIPT: receipt,
          FAIL_COMMAND: scenario.failure,
        },
      });
      expect(result.status === 0 ? 0 : 1).toBe(scenario.status);
      expect((await readFile(receipt, "utf8")).trim().split("\n")).toEqual(
        scenario.commands,
      );
      expect(result.stdout + result.stderr).toContain("fixture lint:staged");
      expect(
        execFileSync("git", ["rev-list", "--count", "HEAD"], {
          cwd,
          encoding: "utf8",
        }).trim(),
      ).toBe(scenario.status === 0 ? "2" : "1");
      if (scenario.differs)
        expect(await readFile(join(cwd, "package.json"), "utf8")).toContain(
          "unstaged",
        );
    },
  );
});

describe("decideReactDoctor", () => {
  it("runs the scan when package.json agrees between index and worktree", () => {
    expect(
      decideReactDoctor({
        packageJsonDiffers: false,
        stagedPaths: ["src/renderer/src/screens/review.tsx"],
      }),
    ).toEqual({ action: "run" });
  });

  it("fails when package.json differs and renderer files are staged", () => {
    const decision = decideReactDoctor({
      packageJsonDiffers: true,
      stagedPaths: ["src/services/review.ts", "src/renderer/src/app.tsx"],
    });

    expect(decision.action).toBe("fail");
    expect(decision).toMatchObject({
      message:
        "React Doctor cannot scan: package.json differs between index and worktree, and renderer files are staged. Stage or restore package.json, then retry.\n",
    });
  });

  it("skips, saying nothing was scanned, when no renderer file is staged", () => {
    const decision = decideReactDoctor({
      packageJsonDiffers: true,
      stagedPaths: ["scripts/precommit.mjs", "AGENTS.md"],
    });

    expect(decision.action).toBe("skip");
    expect(decision).toMatchObject({
      message:
        "React Doctor skipped: package.json differs between index and worktree. Nothing was scanned.\n",
    });
  });

  it("skips rather than failing when nothing at all is staged", () => {
    expect(
      decideReactDoctor({ packageJsonDiffers: true, stagedPaths: [] }).action,
    ).toBe("skip");
  });
});
