import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  hashAvatarUrl,
  writeAvatar,
} from "../../src/adapters/storage/avatar-cache-store";
import { PatchdeskPaths } from "../../src/adapters/storage/patchdesk-paths";
import type { AvatarRailDependencies } from "../../src/services/avatar-sync-service";
import { MaintainerInboxService } from "../../src/services/maintainer-inbox-service";
import { ok } from "../../src/domain/result";

// SAFETY: MaintainerInboxService reads only host/owner/repo off the
// repository parameter; the plain strings stand in for the branded GitHub
// identity types these fixtures never need to parse.
const repository = {
  host: "github.com",
  owner: "centraldigital",
  repo: "patchdesk",
} as never;

describe("MaintainerInboxService author avatars", () => {
  const avatarUrl = "https://avatars.example/other.png?v=4";
  const directories: Array<string> = [];

  afterEach(async () => {
    await Promise.all(
      directories
        .splice(0)
        .map(
          async (directory) =>
            await rm(directory, { force: true, recursive: true }),
        ),
    );
  });

  /**
   * A profile whose avatar cache already holds one PNG for `avatarUrl`, so
   * `resolveAvatarDataUris` has real bytes to read back.
   */
  async function warmedPaths(): Promise<PatchdeskPaths> {
    const root = await mkdtemp(join(tmpdir(), "patchdesk-inbox-avatars-"));
    directories.push(root);
    const paths = PatchdeskPaths.forTest(root);
    const written = await writeAvatar(
      paths,
      // SAFETY: "cfw" is the profile id every fixture in this file lists under.
      "cfw" as never,
      hashAvatarUrl(avatarUrl),
      new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    if (written._tag === "err") throw new Error("could not warm the fixture");
    return paths;
  }

  /** One open row whose author carries `avatarUrl`, read fresh from GitHub. */
  function serviceWithAvatars(
    avatars: AvatarRailDependencies | undefined,
  ): MaintainerInboxService {
    // SAFETY: each fixture below implements exactly the seams list() calls.
    return new MaintainerInboxService(
      {
        resolveAuthenticatedAccount: async () =>
          ok({ host: "github.com", account: "fixture" }),
        searchMaintainerPullRequests: async () =>
          ok({
            entries: [
              {
                cursor: "fixture-42",
                pullRequest: {
                  summary: {
                    ref: {
                      host: "github.com",
                      owner: "centraldigital",
                      repo: "patchdesk",
                      number: 42,
                    },
                    title: "Fixture",
                    author: "other",
                    authorAvatarUrl: avatarUrl,
                    headSha: "a".repeat(40),
                    baseSha: "b".repeat(40),
                    isOpen: true,
                    isDraft: false,
                    reviewState: "none",
                    mergeability: "mergeable",
                    labels: [],
                    updatedAt: "2026-08-01T00:00:00.000Z",
                  },
                  checks: { overall: "passing", checks: [] },
                },
              },
            ],
            hasNextPage: false,
            issueCount: 1,
          }),
      } as never,
      { listSessions: async () => ok([]) } as never,
      {
        read: async () => ({ _tag: "err", error: { reason: "not_found" } }),
        save: async () => ok(undefined),
      } as never,
      { now: () => "2026-08-01T00:00:00.000Z" as never },
      undefined,
      avatars,
    );
  }

  // SAFETY: this minimal profile supplies exactly the fields list() reads.
  const profile = { id: "cfw", ghAccount: "fixture" } as never;

  it("attaches the cached avatar as a data URI, warming it first", async () => {
    const paths = await warmedPaths();
    const warmed: Array<ReadonlyArray<string>> = [];
    const service = serviceWithAvatars({
      paths,
      sync: {
        warmAvatarUrls: async (input: {
          readonly avatarUrls: ReadonlyArray<string>;
        }) => {
          warmed.push(input.avatarUrls);
        },
      },
    });

    const result = await service.list(profile, repository);

    expect(result._tag).toBe("ok");
    if (result._tag !== "ok") return;
    expect(warmed).toEqual([[avatarUrl]]);
    expect(result.value.rows[0]?.authorAvatarDataUri).toBe(
      "data:image/png;base64,iVBORw0KGgo=",
    );
  });

  it("still returns the rows when the avatar dependency throws", async () => {
    const paths = await warmedPaths();
    const service = serviceWithAvatars({
      paths,
      sync: {
        warmAvatarUrls: async () => {
          throw new Error("avatar rail unavailable");
        },
      },
    });

    const result = await service.list(profile, repository);

    expect(result._tag).toBe("ok");
    if (result._tag !== "ok") return;
    expect(result.value.rows).toHaveLength(1);
    expect(result.value.rows[0]?.authorAvatarDataUri).toBeUndefined();
  });

  it("attaches nothing when no avatar dependency is wired", async () => {
    const result = await serviceWithAvatars(undefined).list(
      profile,
      repository,
    );

    expect(result._tag).toBe("ok");
    if (result._tag !== "ok") return;
    expect(result.value.rows[0]?.authorAvatarUrl).toBe(avatarUrl);
    expect(result.value.rows[0]?.authorAvatarDataUri).toBeUndefined();
  });
});
