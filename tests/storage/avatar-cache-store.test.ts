import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  avatarDataUri,
  hasAvatar,
  hashAvatarUrl,
  readAvatar,
  writeAvatar,
} from "../../src/adapters/storage/avatar-cache-store";
import { PatchdeskPaths } from "../../src/adapters/storage/patchdesk-paths";
import { parseWorkspaceProfileId } from "../../src/domain/ids";
import type { Result } from "../../src/domain/result";

const must = <T>(result: Result<T, unknown>): T =>
  result._tag === "ok"
    ? result.value
    : (() => {
        throw new Error("fixture");
      })();
const profileId = must(parseWorkspaceProfileId("cfw"));
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function paths(): Promise<PatchdeskPaths> {
  const root = await mkdtemp(join(tmpdir(), "patchdesk-avatar-"));
  roots.push(root);
  return PatchdeskPaths.forTest(root);
}

// A minimal, valid one-pixel PNG (magic bytes + IHDR/IDAT/IEND), enough to
// exercise the store's content-type sniffing without depending on a real
// download.
const onePixelPng = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49,
  0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02,
  0x00, 0x00, 0x00, 0x90, 0x77, 0x53, 0xde, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44,
  0x41, 0x54, 0x08, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0x00, 0x00, 0x03, 0x01, 0x01,
  0x00, 0x18, 0xdd, 0x8d, 0xb0, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44,
  0xae, 0x42, 0x60, 0x82,
]);

describe("avatar cache store", () => {
  it("round-trips raw bytes for one avatar hash", async () => {
    const store = await paths();
    const hash = hashAvatarUrl("https://avatars.githubusercontent.com/u/1?v=4");
    expect(await hasAvatar(store, profileId, hash)).toBe(false);

    const written = await writeAvatar(store, profileId, hash, onePixelPng);
    expect(written._tag).toBe("ok");

    expect(await hasAvatar(store, profileId, hash)).toBe(true);
    const read = must(await readAvatar(store, profileId, hash));
    expect(Array.from(read)).toEqual(Array.from(onePixelPng));
  });

  it("reports not_found for an avatar never written", async () => {
    const store = await paths();
    const hash = hashAvatarUrl("https://avatars.githubusercontent.com/u/2?v=4");
    const read = await readAvatar(store, profileId, hash);
    expect(read).toMatchObject({
      _tag: "err",
      error: { operation: "read", reason: "not_found" },
    });
  });

  it("hashes the URL as given, so a re-versioned avatar URL is a distinct cache key", () => {
    const before = hashAvatarUrl(
      "https://avatars.githubusercontent.com/u/1?v=3",
    );
    const after = hashAvatarUrl(
      "https://avatars.githubusercontent.com/u/1?v=4",
    );
    expect(before).not.toEqual(after);
    // Deterministic: hashing the same URL twice yields the same key.
    expect(
      hashAvatarUrl("https://avatars.githubusercontent.com/u/1?v=4"),
    ).toEqual(after);
  });

  it("builds a data: URI with a sniffed content type from cached bytes", async () => {
    const store = await paths();
    const hash = hashAvatarUrl("https://avatars.githubusercontent.com/u/3?v=1");
    await writeAvatar(store, profileId, hash, onePixelPng);
    const uri = must(await avatarDataUri(store, profileId, hash));
    expect(uri.startsWith("data:image/png;base64,")).toBe(true);
    const base64 = uri.slice("data:image/png;base64,".length);
    expect(Buffer.from(base64, "base64")).toEqual(Buffer.from(onePixelPng));
  });

  it("keeps two profiles' avatar caches separate", async () => {
    const store = await paths();
    const other = must(parseWorkspaceProfileId("other"));
    const hash = hashAvatarUrl("https://avatars.githubusercontent.com/u/4?v=1");
    await writeAvatar(store, profileId, hash, onePixelPng);
    expect(await hasAvatar(store, profileId, hash)).toBe(true);
    expect(await hasAvatar(store, other, hash)).toBe(false);
  });
});
