import {
  access,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { stageFlueRuntime } from "../../scripts/stage-flue-runtime-lib.mjs";

const roots: string[] = [];
afterEach(
  async () =>
    await Promise.all(
      roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    ),
);

describe("stageFlueRuntime", () => {
  it("stages only the exact Flue 2 runner, smoke entry, skill, lock, and manifest", async () => {
    const fixture = await createFixture();
    const calls: Array<{ command: string; args: string[] }> = [];
    await stageFlueRuntime({
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
      args: ["--dir", join(fixture.projectRoot, "runtime", "flue"), "build"],
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
      flueVersion: "2.0.3",
      piVersion: "0.84.1",
      catalogDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      nodeFloor: ">=22.19.0",
    });
  });

  it("clears a previous runtime and fails closed when offline install fails", async () => {
    const fixture = await createFixture();
    await mkdir(join(fixture.runtimeRoot, "old"), { recursive: true });
    await expect(
      stageFlueRuntime({
        ...fixture,
        run: async (_command: string, args: string[]) => {
          if (args.includes("install")) throw new Error("store incomplete");
          return "";
        },
      }),
    ).rejects.toThrow("exact locked Flue runtime");
    await expect(access(join(fixture.runtimeRoot, "old"))).rejects.toThrow();
  });

  it("locks a peer-safe production runtime and filters package-only metadata", async () => {
    const projectRoot = resolve(import.meta.dirname, "../..");
    const runtimePackage = JSON.parse(
      await readFile(join(projectRoot, "runtime/flue/package.json"), "utf8"),
    ) as {
      scripts: { "deploy:verify": string };
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    const runtimeLock = await readFile(
      join(projectRoot, "runtime/flue/pnpm-lock.yaml"),
      "utf8",
    );
    const rootPackage = JSON.parse(
      await readFile(join(projectRoot, "package.json"), "utf8"),
    ) as {
      build: { extraResources: Array<{ filter: string[] }> };
    };

    expect(runtimePackage.scripts["deploy:verify"]).toContain(
      "--config.auto-install-peers=false",
    );
    expect(runtimePackage.devDependencies).not.toHaveProperty("typescript");
    expect(runtimePackage.dependencies.zod).toBe("4.4.3");
    expect(runtimeLock).toContain("autoInstallPeers: false");
    expect(runtimeLock).not.toMatch(/\/typescript@|valibot@[^\n]*typescript/);
    for (const providerSdk of [
      "@anthropic-ai/sdk",
      "@aws-sdk/client-bedrock-runtime",
      "@google/genai",
      "@mistralai/mistralai",
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
});

async function createFixture() {
  const projectRoot = await mkdtemp(
    join(tmpdir(), "patchdesk-stage-flue-runtime-"),
  );
  roots.push(projectRoot);
  const runtimeRoot = join(projectRoot, "out", "workflow-runtime");
  const source = join(projectRoot, "runtime", "flue");
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
      '{"dependencies":{"@flue/runtime":"2.0.3","@earendil-works/pi-ai":"0.84.1"}}\n',
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
