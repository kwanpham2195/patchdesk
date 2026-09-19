import { createHash } from "node:crypto";
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  at,
  fixture,
  profileId,
  sessionId,
  snapshot,
} from "./review-workbench-projection-fixture";

/**
 * `project()` runs on every open, load, and post-refresh render, and the
 * patch it hashes is immutable for the life of a Session. These tests pin
 * that the hash is computed once per `(size, mtimeMs)` file identity rather
 * than once per projection, and that a patch whose identity changes is
 * hashed again — the property that keeps a replaced patch from projecting a
 * retained Insight as current.
 */
describe("ReviewWorkbenchProjectionService patch hashing", () => {
  const patch = "diff --git a/one.ts b/one.ts\n-old\n+new\n";
  const replacement = "diff --git a/two.ts b/two.ts\n-OLD\n+NEW\n";
  let root = "";
  let patchPath = "";

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "patchdesk-projection-hash-"));
    patchPath = join(root, "session.patch");
    await writeFile(patchPath, patch, "utf8");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function projectedHash(
    service: ReturnType<typeof fixture>["service"],
  ): Promise<string | undefined> {
    const result = await service.loadRepresented({
      profileId,
      sessionId,
      snapshot,
      refreshedAt: at,
      freshness: { _tag: "Fresh" },
    });
    if (result._tag !== "ok") throw new Error("expected an ok projection");
    return result.value.revision.patchHash;
  }

  it("hashes one Session's patch once across repeated projections", async () => {
    // A whole-millisecond timestamp both writes are pinned to, so the file
    // identity is byte-for-byte the same before and after the replacement.
    const pinned = new Date(1_700_000_000_000);
    expect(replacement.length).toBe(patch.length);
    await utimes(patchPath, pinned, pinned);

    const { service } = fixture(undefined, undefined, patchPath);
    const first = await projectedHash(service);
    expect(first).toBe(createHash("sha256").update(patch).digest("hex"));

    // Replacing the bytes while keeping the size and mtime leaves the cache
    // key untouched, so a second hash of that identity would have to read as
    // the replacement. It still reads as the first hash, which is only
    // possible if the second projection did not hash at all.
    await writeFile(patchPath, replacement, "utf8");
    await utimes(patchPath, pinned, pinned);

    await expect(projectedHash(service)).resolves.toBe(first);
  });

  it("hashes again once the patch file's identity changes", async () => {
    const { service } = fixture(undefined, undefined, patchPath);
    await projectedHash(service);

    await writeFile(patchPath, `${replacement}+extra\n`, "utf8");

    await expect(projectedHash(service)).resolves.toBe(
      createHash("sha256").update(`${replacement}+extra\n`).digest("hex"),
    );
  });
});
