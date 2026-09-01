import { mkdtemp, mkdir, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  PACKAGE_SIZE_LIMITS_MIB,
  validatePackageSizes,
} from "../../scripts/package-size-validation.mjs";

const roots: string[] = [];
const oneMiB = 1024 * 1024;
const fixtureLimits = {
  asar: 1,
  flue: 1,
  app: 2,
  dmg: 1,
  zip: 1,
} as const;

afterEach(
  async () =>
    await Promise.all(
      roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    ),
);

describe("validatePackageSizes", () => {
  it("measures all five artifacts without building", async () => {
    const fixture = await createFixture();

    const measurements = await validatePackageSizes(fixture, fixtureLimits);

    expect(
      measurements.map(({ name, bytes, limitMiB }) => ({
        name,
        bytes,
        limitMiB,
      })),
    ).toEqual([
      { name: "app.asar", bytes: 200, limitMiB: 1 },
      { name: "flue-runtime", bytes: 300, limitMiB: 1 },
      { name: "Patchdesk.app", bytes: 600, limitMiB: 2 },
      { name: "DMG", bytes: 400, limitMiB: 1 },
      { name: "ZIP", bytes: 500, limitMiB: 1 },
    ]);
  });

  it("reports measured and limit values when an artifact is too large", async () => {
    const fixture = await createFixture();
    await truncate(fixture.zip, oneMiB + 1);

    await expect(validatePackageSizes(fixture, fixtureLimits)).rejects.toThrow(
      "ZIP measured 1.00 MiB (1048577 bytes), limit 1.00 MiB (1048576 bytes)",
    );
  });

  it("fails closed for a missing artifact", async () => {
    const fixture = await createFixture();
    await rm(fixture.dmg);

    await expect(validatePackageSizes(fixture, fixtureLimits)).rejects.toThrow(
      `DMG is missing: ${fixture.dmg}`,
    );
  });

  it("rejects an empty artifact instead of passing vacuously", async () => {
    const fixture = await createFixture();
    await truncate(fixture.zip, 0);

    await expect(validatePackageSizes(fixture, fixtureLimits)).rejects.toThrow(
      `ZIP is empty: ${fixture.zip}`,
    );
  });

  it("pins rounded production limits with headroom", () => {
    expect(PACKAGE_SIZE_LIMITS_MIB).toEqual({
      asar: 30,
      flue: 50,
      app: 360,
      dmg: 135,
      zip: 145,
    });
  });
});

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "patchdesk-package-sizes-"));
  roots.push(root);
  const bundle = join(root, "Patchdesk.app");
  const resources = join(bundle, "Contents", "Resources");
  const flue = join(resources, "flue-runtime");
  const asar = join(resources, "app.asar");
  const dmg = join(root, "Patchdesk.dmg");
  const zip = join(root, "Patchdesk.zip");
  await mkdir(flue, { recursive: true });
  await Promise.all([
    writeFile(asar, Buffer.alloc(200)),
    writeFile(join(flue, "runtime.js"), Buffer.alloc(300)),
    writeFile(join(bundle, "binary"), Buffer.alloc(100)),
    writeFile(dmg, Buffer.alloc(400)),
    writeFile(zip, Buffer.alloc(500)),
  ]);
  return { bundle, dmg, zip };
}
