import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PatchdeskPaths } from "../../src/adapters/storage/patchdesk-paths";
import { parseWorkspaceProfileId } from "../../src/domain/ids";
import { parsePullRequestInput } from "../../src/domain/pull-request";
import { ok, type Result } from "../../src/domain/result";
import {
  parseWorkspaceProfileConfig,
  type WorkspaceProfileConfig,
} from "../../src/domain/workspace-profile";
import {
  PullRequestImageService,
  type ImageHttpFetch,
} from "../../src/services/pull-request-image-service";

const must = <T>(result: Result<T, unknown>): T => {
  if (result._tag === "err") throw new Error("fixture");
  return result.value;
};

const profileId = must(parseWorkspaceProfileId("acme"));
const pullRequest = must(
  parsePullRequestInput("https://github.com/acme/widgets/pull/7"),
);
const profile: WorkspaceProfileConfig = must(
  parseWorkspaceProfileConfig({
    id: "acme",
    label: "Acme",
    githubHost: "github.com",
    ghAccount: "reviewer",
    workspaceRoots: ["/tmp/acme"],
    rulePaths: [],
    repos: [],
  }),
);

const png = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01,
]);

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function paths(): Promise<PatchdeskPaths> {
  const root = await mkdtemp(join(tmpdir(), "patchdesk-pr-image-"));
  roots.push(root);
  return PatchdeskPaths.forTest(root);
}

async function service(
  fetch: ImageHttpFetch,
): Promise<PullRequestImageService> {
  return new PullRequestImageService({
    paths: await paths(),
    profiles: { load: async () => ok(profile) },
    credentials: {
      environmentFor: async () => ok({ GH_TOKEN: "secret-token" }),
      forget: () => {},
    },
    fetch,
  });
}

/** Answers every request with `response`, recording the URL and headers it was called with. */
function stubFetch(answer: (url: string) => Response): ImageHttpFetch & {
  readonly calls: Array<[string, Record<string, string>]>;
} {
  const calls: Array<[string, Record<string, string>]> = [];
  const fetch = vi.fn(async (url: string, init) => {
    calls.push([url, { ...init.headers }]);
    return answer(url);
  });
  return Object.assign(fetch, { calls });
}

describe("PullRequestImageService", () => {
  it("downloads an image on the pull request's host and answers with a data URI", async () => {
    const fetch = stubFetch(() => new Response(png));
    const images = await service(fetch);

    const resolved = await images.resolve({
      profileId,
      pullRequest,
      imageUrl: "https://github.com/user-attachments/assets/abc",
    });

    expect(resolved).toEqual({
      _tag: "ok",
      value: {
        dataUri: `data:image/png;base64,${Buffer.from(png).toString("base64")}`,
      },
    });
    expect(fetch.calls).toHaveLength(1);
  });

  it("serves a second view of the same image from the disk cache without a network call", async () => {
    const fetch = stubFetch(() => new Response(png));
    const images = await service(fetch);
    const input = {
      profileId,
      pullRequest,
      imageUrl: "https://github.com/user-attachments/assets/abc",
    };

    const first = await images.resolve(input);
    const second = await images.resolve(input);

    expect(second).toEqual(first);
    expect(fetch.calls).toHaveLength(1);
  });

  it("sends the profile token to the GitHub host and never to the redirect target", async () => {
    // The real URL github.com answers a user attachment with: a presigned
    // object in GitHub's user-asset bucket, not a githubusercontent.com host.
    const signed =
      "https://github-production-user-asset-6210df.s3.amazonaws.com/1/a.png?X-Amz-Signature=x";
    const fetch = stubFetch((url) =>
      url === signed
        ? new Response(png)
        : new Response(null, { status: 302, headers: { location: signed } }),
    );
    const images = await service(fetch);

    const resolved = await images.resolve({
      profileId,
      pullRequest,
      imageUrl: "https://github.com/user-attachments/assets/abc",
    });

    expect(resolved._tag).toBe("ok");
    expect(fetch.calls.map(([url]) => url)).toEqual([
      "https://github.com/user-attachments/assets/abc",
      signed,
    ]);
    expect(fetch.calls[0]?.[1].Authorization).toBe("Bearer secret-token");
    expect(fetch.calls[1]?.[1].Authorization).toBeUndefined();
  });

  it.each([
    [
      "a host that is neither the GitHub host nor an asset host",
      "https://evil.example/a.png",
    ],
    ["a plain HTTP URL", "http://github.com/user-attachments/assets/abc"],
    ["credentials embedded in the URL", "https://user:pw@github.com/a.png"],
    ["an explicit port", "https://github.com:8443/a.png"],
  ])("refuses %s without contacting it", async (_case, imageUrl) => {
    const fetch = stubFetch(() => new Response(png));
    const images = await service(fetch);

    const resolved = await images.resolve({ profileId, pullRequest, imageUrl });

    expect(resolved).toEqual({
      _tag: "err",
      error: { reason: "invalid_input" },
    });
    expect(fetch.calls).toHaveLength(0);
  });

  it("refuses a pull request on a host the profile is not configured with", async () => {
    const foreign = must(
      parsePullRequestInput("https://evil.example/acme/widgets/pull/7"),
    );
    const fetch = stubFetch(() => new Response(png));
    const images = await service(fetch);

    const resolved = await images.resolve({
      profileId,
      pullRequest: foreign,
      imageUrl: "https://evil.example/user-attachments/assets/abc",
    });

    expect(resolved).toEqual({
      _tag: "err",
      error: { reason: "invalid_input" },
    });
    expect(fetch.calls).toHaveLength(0);
  });

  it("refuses a redirect that leaves the allowed hosts", async () => {
    const fetch = stubFetch(
      () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://evil.example/a.png" },
        }),
    );
    const images = await service(fetch);

    const resolved = await images.resolve({
      profileId,
      pullRequest,
      imageUrl: "https://github.com/user-attachments/assets/abc",
    });

    expect(resolved).toEqual({
      _tag: "err",
      error: { reason: "invalid_input" },
    });
    expect(fetch.calls).toHaveLength(1);
  });

  it("refuses a response declaring more bytes than the cap", async () => {
    const fetch = stubFetch(
      () =>
        new Response(png, {
          headers: { "content-length": String(8 * 1024 * 1024) },
        }),
    );
    const images = await service(fetch);

    const resolved = await images.resolve({
      profileId,
      pullRequest,
      imageUrl: "https://github.com/user-attachments/assets/abc",
    });

    expect(resolved).toEqual({
      _tag: "err",
      error: { reason: "invalid_result" },
    });
  });

  it("refuses a body that streams past the cap without declaring its length", async () => {
    const megabyte = new Uint8Array(1024 * 1024);
    megabyte.set(png);
    const fetch = stubFetch(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              controller.enqueue(megabyte);
            },
          }),
        ),
    );
    const images = await service(fetch);

    const resolved = await images.resolve({
      profileId,
      pullRequest,
      imageUrl: "https://github.com/user-attachments/assets/abc",
    });

    expect(resolved).toEqual({
      _tag: "err",
      error: { reason: "invalid_result" },
    });
  });

  it("refuses bytes that are not a recognized image", async () => {
    const fetch = stubFetch(() => new Response(new Uint8Array([1, 2, 3, 4])));
    const images = await service(fetch);

    const resolved = await images.resolve({
      profileId,
      pullRequest,
      imageUrl: "https://github.com/user-attachments/assets/abc",
    });

    expect(resolved).toEqual({
      _tag: "err",
      error: { reason: "invalid_result" },
    });
  });

  it("reports a missing image as not found and a refused read as a GitHub failure", async () => {
    const missing = await service(
      stubFetch(() => new Response(null, { status: 404 })),
    );
    const refused = await service(
      stubFetch(() => new Response(null, { status: 500 })),
    );
    const input = {
      profileId,
      pullRequest,
      imageUrl: "https://github.com/user-attachments/assets/abc",
    };

    expect(await missing.resolve(input)).toEqual({
      _tag: "err",
      error: { reason: "not_found" },
    });
    expect(await refused.resolve(input)).toEqual({
      _tag: "err",
      error: { reason: "github_read" },
    });
  });
});
