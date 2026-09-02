import {
  access,
  cp,
  mkdtemp,
  mkdir,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

import { stageInsightRuntime } from "../../scripts/stage-insight-runtime-lib.mjs";

const roots: string[] = [];
const execFileAsync = promisify(execFile);
afterEach(
  async () =>
    await Promise.all(
      roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    ),
);

describe("stageInsightRuntime", () => {
  it("stages only the exact insight runner, smoke entry, skill, lock, and manifest", async () => {
    const fixture = await createFixture();
    const calls: Array<{ command: string; args: string[] }> = [];
    await stageInsightRuntime({
      ...fixture,
      run: async (command: string, args: string[]) => {
        calls.push({ command, args });
        if (command === "pnpm" && args.includes("install"))
          await mkdir(join(fixture.runtimeRoot, "node_modules"), {
            recursive: true,
          });
        return "";
      },
    });
    expect(calls).toContainEqual({
      command: "pnpm",
      args: ["--dir", join(fixture.projectRoot, "runtime", "insight"), "build"],
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
        "--config.auto-install-peers=false",
      ],
    });
    await expect(
      access(join(fixture.runtimeRoot, "patchdesk-insight-runner.js")),
    ).resolves.toBeUndefined();
    await expect(
      access(join(fixture.runtimeRoot, "package-smoke-runner.js")),
    ).resolves.toBeUndefined();
    await expect(
      access(
        join(
          fixture.runtimeRoot,
          "skills",
          "patchdesk-code-review",
          "SKILL.md",
        ),
      ),
    ).resolves.toBeUndefined();
    expect(
      JSON.parse(
        await readFile(
          join(fixture.runtimeRoot, "runtime-manifest.json"),
          "utf8",
        ),
      ),
    ).toMatchObject({
      piVersion: "0.84.4",
      catalogDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      nodeFloor: ">=22.19.0",
    });
  });

  it("clears a previous runtime and fails closed when offline install fails", async () => {
    const fixture = await createFixture();
    await mkdir(join(fixture.runtimeRoot, "old"), { recursive: true });
    await expect(
      stageInsightRuntime({
        ...fixture,
        run: async (_command: string, args: string[]) => {
          if (args.includes("install")) throw new Error("store incomplete");
          return "";
        },
      }),
    ).rejects.toThrow("exact locked insight runtime");
    await expect(access(join(fixture.runtimeRoot, "old"))).rejects.toThrow();
  });

  it("locks a peer-safe production runtime and filters package-only metadata", async () => {
    const projectRoot = resolve(import.meta.dirname, "../..");
    const runtimePackage = JSON.parse(
      await readFile(join(projectRoot, "runtime/insight/package.json"), "utf8"),
    ) as {
      scripts: { "deploy:verify": string };
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    const runtimeLock = await readFile(
      join(projectRoot, "runtime/insight/pnpm-lock.yaml"),
      "utf8",
    );
    const rootPackage = JSON.parse(
      await readFile(join(projectRoot, "package.json"), "utf8"),
    ) as {
      build: { extraResources: Array<{ filter: string[] }> };
      scripts: { prepare: string };
    };

    expect(rootPackage.scripts.prepare).toContain(
      "--config.auto-install-peers=false",
    );

    expect(runtimePackage.scripts["deploy:verify"]).toContain(
      "--config.auto-install-peers=false",
    );
    expect(runtimePackage.devDependencies.typescript).toBe("5.9.3");
    expect(runtimePackage.dependencies).not.toHaveProperty("zod");
    expect(runtimeLock).toContain("autoInstallPeers: false");
    for (const providerSdk of [
      "@anthropic-ai/sdk",
      "@aws-sdk/client-bedrock-runtime",
      "@google/genai",
      "openai",
    ])
      expect(runtimeLock).toContain(`/${providerSdk}@`);

    for (const { filter } of rootPackage.build.extraResources) {
      expect(filter).toContain("!**/*.{d.ts,d.mts,d.cts,map}");
      expect(filter).toContain(
        "!**/{README,README.*,readme,readme.*,CHANGELOG,CHANGELOG.*,changelog,changelog.*,HISTORY,HISTORY.*,history,history.*}",
      );
    }
  });

  it("keeps TypeScript for development but removes it from the staged production tree", async () => {
    const projectRoot = resolve(import.meta.dirname, "../..");
    const fixture = await createFixture();
    await Promise.all([
      cp(
        join(projectRoot, "runtime/insight/package.json"),
        join(fixture.projectRoot, "runtime/insight/package.json"),
      ),
      cp(
        join(projectRoot, "runtime/insight/pnpm-lock.yaml"),
        join(fixture.projectRoot, "runtime/insight/pnpm-lock.yaml"),
      ),
    ]);

    await stageInsightRuntime({
      ...fixture,
      run: async (command: string, args: string[]) => {
        if (args.includes("build")) return "";
        const { stdout } = await execFileAsync(command, args, {
          cwd: fixture.projectRoot,
        });
        return stdout;
      },
    });

    const stagedPaths = await readdir(
      join(fixture.runtimeRoot, "node_modules"),
      { recursive: true },
    );
    expect(
      stagedPaths.filter((path) =>
        path
          .split("/")
          .some(
            (segment) =>
              segment === "typescript" || segment.startsWith("typescript@"),
          ),
      ),
    ).toEqual([]);
  }, 30_000);
});

async function createFixture() {
  const projectRoot = await mkdtemp(
    join(tmpdir(), "patchdesk-stage-insight-runtime-"),
  );
  roots.push(projectRoot);
  const runtimeRoot = join(projectRoot, "out", "workflow-runtime");
  const source = join(projectRoot, "runtime", "insight");
  await Promise.all([
    mkdir(join(source, "dist"), { recursive: true }),
    mkdir(join(projectRoot, "src", "skills", "patchdesk-code-review"), {
      recursive: true,
    }),
    mkdir(join(projectRoot, "src", "adapters", "pi"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(
      join(source, "package.json"),
      '{"dependencies":{"@earendil-works/pi-agent-core":"0.84.4","@earendil-works/pi-ai":"0.84.4"}}\n',
    ),
    writeFile(join(source, "pnpm-lock.yaml"), "lockfileVersion: '6.0'\n"),
    writeFile(join(source, "dist", "patchdesk-insight-runner.js"), ""),
    writeFile(join(source, "dist", "package-smoke-runner.js"), ""),
    writeFile(
      join(source, "runtime-manifest.json"),
      '{"catalogDigest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}\n',
    ),
    writeFile(
      join(projectRoot, "src", "adapters", "pi", "pi-ai-catalog.generated.ts"),
      'export const generatedPiAiCatalog: unknown = {\n  digest: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",\n};\n',
    ),
    writeFile(
      join(projectRoot, "src", "skills", "patchdesk-code-review", "SKILL.md"),
      "# Skill\n",
    ),
  ]);
  return { projectRoot, runtimeRoot };
}
