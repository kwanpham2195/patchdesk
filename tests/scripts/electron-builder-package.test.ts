import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const runtimeDependencies = ["@hono/node-server", "hono", "valibot"];

async function readPackageJson() {
  return JSON.parse(
    await readFile(resolve(import.meta.dirname, "../../package.json"), "utf8"),
  ) as {
    dependencies: Record<string, string>;
    build: { electronLanguages?: string[] };
  };
}

describe("electron-builder package configuration", () => {
  it("copies only main-process runtime dependencies", async () => {
    const packageJson = await readPackageJson();

    expect(Object.keys(packageJson.dependencies).sort()).toEqual(
      runtimeDependencies,
    );
  });

  it("keeps only the English Electron locale", async () => {
    const packageJson = await readPackageJson();

    expect(packageJson.build.electronLanguages).toEqual(["en"]);
  });
});
