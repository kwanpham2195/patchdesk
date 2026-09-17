import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { PatchdeskPaths } from "../../src/adapters/storage/patchdesk-paths";
import { WatchedPullRequestStore } from "../../src/adapters/storage/watched-pull-request-store";
import { parseWorkspaceProfileId } from "../../src/domain/ids";
import { parseWatchedPullRequests } from "../../src/domain/watched-pull-request";

const roots: string[] = [];
afterEach(async () =>
  Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  ),
);

async function storeFixture(): Promise<{
  readonly paths: PatchdeskPaths;
  readonly store: WatchedPullRequestStore;
}> {
  const root = await mkdtemp(join(tmpdir(), "patchdesk-watched-"));
  roots.push(root);
  const paths = PatchdeskPaths.forTest(root);
  return { paths, store: new WatchedPullRequestStore(paths) };
}

const profile = parseWorkspaceProfileId("cfw");
const list = parseWatchedPullRequests([
  {
    ref: { host: "github.com", owner: "acme", repo: "widgets", number: 7 },
    snapshot: {
      updatedAt: "2026-09-16T10:00:00.000Z",
      headSha: "a".repeat(40),
      reviewState: "approved",
      checks: "passing",
      state: "open",
    },
    watchedAt: "2026-09-16T09:00:00.000Z",
  },
]);

describe("WatchedPullRequestStore", () => {
  it("round-trips the watched list and reads a missing file as empty", async () => {
    if (profile._tag !== "ok" || list._tag !== "ok")
      throw new Error("invalid fixture");
    const { store } = await storeFixture();

    await expect(store.load(profile.value)).resolves.toEqual({
      _tag: "ok",
      value: [],
    });
    await store.save(profile.value, list.value);
    await expect(store.load(profile.value)).resolves.toEqual({
      _tag: "ok",
      value: list.value,
    });
  });

  it("reads an invalid file as invalid_stored_value", async () => {
    if (profile._tag !== "ok") throw new Error("invalid fixture");
    const { paths, store } = await storeFixture();
    const file = paths.watchedPullRequestsFile(profile.value);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify([{ ref: "acme/widgets#7" }]));

    await expect(store.load(profile.value)).resolves.toEqual({
      _tag: "err",
      error: {
        _tag: "StorageFailure",
        operation: "read",
        reason: "invalid_stored_value",
      },
    });
  });
});
