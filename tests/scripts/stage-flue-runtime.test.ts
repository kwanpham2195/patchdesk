import {
  access,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { stageFlueRuntime } from "../../scripts/stage-flue-runtime-lib.mjs";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map(async (root) => await rm(root, { recursive: true, force: true })),
  );
});

describe("stageFlueRuntime", () => {
  it("copies committed inputs and stages the current beta CLI and walkthrough root", async () => {
    const fixture = await createFixture();
    const calls: Array<{ command: string; args: string[] }> = [];
    await stageFlueRuntime({
      ...fixture,
      run: async (command: string, args: string[]) => {
        calls.push({ command, args });
        if (command === "pnpm") {
          await mkdir(
            join(fixture.runtimeRoot, "node_modules", "@flue", "cli", "bin"),
            { recursive: true },
          );
          await writeFile(
            join(
              fixture.runtimeRoot,
              "node_modules",
              "@flue",
              "cli",
              "bin",
              "flue.mjs",
            ),
            "",
          );
          return "";
        }
        return "1.0.0-beta.9\n";
      },
    });

    expect(calls).toContainEqual({
      command: "pnpm",
      args: [
        "--dir",
        fixture.runtimeRoot,
        "install",
        "--frozen-lockfile",
        "--prod",
        "--offline",
        "--ignore-scripts",
      ],
    });
    await expect(
      readFile(join(fixture.runtimeRoot, "package.json"), "utf8"),
    ).resolves.toContain('"@flue/cli":"1.0.0-beta.9"');
    await expect(
      readFile(join(fixture.runtimeRoot, "pnpm-lock.yaml"), "utf8"),
    ).resolves.toBe("lockfileVersion: '6.0'\n");
    await expect(
      access(join(fixture.runtimeRoot, "walkthrough", "flue.config.ts")),
    ).resolves.toBeUndefined();
    await expect(
      access(join(fixture.runtimeRoot, "walkthrough", "node_modules")),
    ).resolves.toBeUndefined();
  });

  it("clears an old staged runtime before missing locked inputs fail", async () => {
    const fixture = await createFixture();
    await mkdir(join(fixture.runtimeRoot, "node_modules", "old-cache"), {
      recursive: true,
    });
    await writeFile(
      join(fixture.runtimeRoot, "node_modules", "old-cache", "sentinel"),
      "stale",
    );
    await rm(
      join(fixture.projectRoot, "runtime", "flue-beta9", "pnpm-lock.yaml"),
    );

    await expect(
      stageFlueRuntime({
        ...fixture,
        run: async () => {
          throw new Error("must not run");
        },
      }),
    ).rejects.toThrow();

    await expect(
      access(
        join(fixture.runtimeRoot, "node_modules", "old-cache", "sentinel"),
      ),
    ).rejects.toThrow();
  });

  it("fails closed after clearing an old staged runtime when the locked install fails", async () => {
    const fixture = await createFixture();
    await mkdir(join(fixture.runtimeRoot, "node_modules", "old-cache"), {
      recursive: true,
    });
    await writeFile(
      join(fixture.runtimeRoot, "node_modules", "old-cache", "sentinel"),
      "stale",
    );

    await expect(
      stageFlueRuntime({
        ...fixture,
        run: async () => {
          throw new Error("store incomplete");
        },
      }),
    ).rejects.toThrow(
      "The exact locked Flue runtime could not be staged offline",
    );

    await expect(
      access(
        join(fixture.runtimeRoot, "node_modules", "old-cache", "sentinel"),
      ),
    ).rejects.toThrow();
    await expect(
      readFile(join(fixture.runtimeRoot, "pnpm-lock.yaml"), "utf8"),
    ).resolves.toBe("lockfileVersion: '6.0'\n");
  });
});

async function createFixture() {
  const projectRoot = await mkdtemp(
    join(tmpdir(), "patchdesk-stage-flue-runtime-"),
  );
  temporaryRoots.push(projectRoot);
  const runtimeRoot = join(projectRoot, "out", "workflow-runtime");
  await Promise.all([
    mkdir(join(projectRoot, "runtime", "flue-beta9"), { recursive: true }),
    mkdir(join(projectRoot, "src"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(
      join(projectRoot, "runtime", "flue-beta9", "package.json"),
      '{"dependencies":{"@flue/cli":"1.0.0-beta.9"}}\n',
    ),
    writeFile(
      join(projectRoot, "runtime", "flue-beta9", "pnpm-lock.yaml"),
      "lockfileVersion: '6.0'\n",
    ),
    writeFile(join(projectRoot, "flue.config.ts"), "export default {};\n"),
    ...["adapters", "domain", "services", "skills", "workflows"].map(
      async (directory) =>
        await mkdir(join(projectRoot, "src", directory), { recursive: true }),
    ),
    ...[
      "flue-assets.d.ts",
      "flue-runtime-types.ts",
      "flue-routing-types.ts",
    ].map(
      async (file) =>
        await writeFile(join(projectRoot, "src", file), "export {};\n"),
    ),
  ]);
  return { projectRoot, runtimeRoot };
}
