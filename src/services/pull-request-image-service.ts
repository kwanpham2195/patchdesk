import type { PatchdeskPaths } from "../adapters/storage/patchdesk-paths";
import type { ProfileStore } from "../adapters/storage/profile-store";
import {
  hashPullRequestImageUrl,
  imageDataUri,
  readPullRequestImageDataUri,
  writePullRequestImage,
} from "../adapters/storage/pull-request-image-cache-store";
import type { GitHubCredentials } from "../adapters/github/github-credentials";
import type { GitHubHost, WorkspaceProfileId } from "../domain/ids";
import type { PullRequestRef } from "../domain/pull-request";
import { err, ok, type Result } from "../domain/result";
import type { WorkspaceProfileConfig } from "../domain/workspace-profile";
import type { AppLogService } from "./app-log-service";

/**
 * Ceiling on one downloaded image. The renderer receives the bytes as a
 * base64 `data:` URI through the desktop bridge, which refuses a response
 * above 8 MB; base64 inflates by a third, so 4 MiB is the largest raw image
 * that still fits with room for the JSON envelope.
 */
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
/** GitHub answers a user-attachment URL with one redirect to a signed host; a few more absorb future hops. */
const MAX_REDIRECTS = 5;
const IMAGE_FETCH_TIMEOUT_MS = 10_000;

export type PullRequestImageFailure = {
  readonly reason:
    | "invalid_input"
    | "invalid_result"
    | "not_found"
    | "github_read";
};

/** The HTTP seam this service needs; the platform `fetch` satisfies it. */
export type ImageHttpFetch = (
  url: string,
  init: {
    readonly headers: Readonly<Record<string, string>>;
    readonly redirect: "manual";
    readonly signal: AbortSignal;
  },
) => Promise<Response>;

export type PullRequestImageDependencies = {
  readonly paths: PatchdeskPaths;
  readonly profiles: Pick<ProfileStore, "load">;
  readonly credentials: GitHubCredentials;
  readonly fetch: ImageHttpFetch;
  /** Best-effort diagnostics; a refused image is already visible as a placeholder. */
  readonly log?: Pick<AppLogService, "write">;
};

/**
 * Resolves one image referenced by a pull request body or comment into a
 * `data:` URI the renderer can display, on demand rather than eagerly: a
 * description can carry several megabyte-sized screenshots, and none of them
 * belong in the stored workbench snapshot.
 *
 * The renderer is never trusted with which URL is safe to fetch. Every URL is
 * re-validated here against the pull request's own host, every redirect hop
 * is validated again, and the profile's GitHub token is attached only to the
 * first request and only when it goes to that profile's GitHub host.
 */
export class PullRequestImageService {
  constructor(private readonly dependencies: PullRequestImageDependencies) {}

  async resolve(input: {
    readonly profileId: WorkspaceProfileId;
    readonly pullRequest: PullRequestRef;
    readonly imageUrl: string;
  }): Promise<Result<{ readonly dataUri: string }, PullRequestImageFailure>> {
    const target = resolvePullRequestImageUrl(
      input.imageUrl,
      input.pullRequest,
    );
    if (target === undefined) return err({ reason: "invalid_input" });

    const imageHash = hashPullRequestImageUrl(target);
    const cached = await readPullRequestImageDataUri(
      this.dependencies.paths,
      input.profileId,
      imageHash,
    );
    if (cached._tag === "ok") return ok({ dataUri: cached.value });

    const profile = await this.dependencies.profiles.load(input.profileId);
    if (profile._tag === "err") return err({ reason: "not_found" });

    const downloaded = await this.download(target, profile.value);
    if (downloaded._tag === "err") return downloaded;
    const dataUri = imageDataUri(downloaded.value);
    if (dataUri === undefined) return err({ reason: "invalid_result" });

    const written = await writePullRequestImage(
      this.dependencies.paths,
      input.profileId,
      imageHash,
      downloaded.value,
    );
    if (written._tag === "err") {
      // A cache miss costs one re-fetch on the next view; nothing else.
      this.dependencies.log?.write({
        process: "main",
        level: "debug",
        topic: "pull-request-image",
        message: "image cache write failed; served without caching",
        profileId: input.profileId,
      });
    }
    return ok({ dataUri });
  }

  /**
   * Follows redirects by hand so every hop's host is checked before it is
   * requested, and so the token never travels to a redirect target: GitHub
   * answers `github.com/user-attachments/assets/<uuid>` with a signed
   * `private-user-images.githubusercontent.com` URL that carries its own
   * authorization in the query string.
   */
  private async download(
    imageUrl: string,
    profile: WorkspaceProfileConfig,
  ): Promise<Result<Uint8Array, PullRequestImageFailure>> {
    const token = await this.token(imageUrl, profile);
    let target = imageUrl;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      const headers =
        hop === 0 && token !== undefined
          ? { Accept: "image/*", Authorization: `Bearer ${token}` }
          : { Accept: "image/*" };
      let response: Response;
      try {
        response = await this.dependencies.fetch(target, {
          headers,
          redirect: "manual",
          signal: AbortSignal.timeout(IMAGE_FETCH_TIMEOUT_MS),
        });
      } catch {
        return err({ reason: "github_read" });
      }
      if (isRedirect(response.status)) {
        const location = response.headers.get("location");
        if (location === null) return err({ reason: "github_read" });
        const next = resolveImageUrl(location, target, profile.githubHost);
        if (next === undefined) return err({ reason: "invalid_input" });
        target = next;
        continue;
      }
      if (response.status === 404) return err({ reason: "not_found" });
      if (!response.ok) return err({ reason: "github_read" });
      return readBoundedBody(response);
    }
    return err({ reason: "github_read" });
  }

  /** The profile's GitHub token, only for a request to that profile's own GitHub host. */
  private async token(
    imageUrl: string,
    profile: WorkspaceProfileConfig,
  ): Promise<string | undefined> {
    if (!isHost(imageUrl, profile.githubHost)) return undefined;
    const environment =
      await this.dependencies.credentials.environmentFor(profile);
    if (environment._tag === "err") return undefined;
    // `environmentFor` answers with exactly one entry: GH_TOKEN, or
    // GH_ENTERPRISE_TOKEN for a GitHub Enterprise Server host.
    return Object.values(environment.value)[0];
  }
}

/**
 * Absolutizes an image reference against the pull request's own page and
 * accepts it only on a host GitHub serves pull-request images from. Relative
 * references resolve here rather than in the renderer, so the main process
 * stays the only authority on which URL is fetched.
 */
function resolvePullRequestImageUrl(
  imageUrl: string,
  pullRequest: PullRequestRef,
): string | undefined {
  const base = `https://${pullRequest.host}/${pullRequest.owner}/${pullRequest.repo}/pull/${pullRequest.number}`;
  return resolveImageUrl(imageUrl, base, pullRequest.host);
}

function resolveImageUrl(
  imageUrl: string,
  base: string,
  githubHost: GitHubHost,
): string | undefined {
  let url: URL;
  try {
    url = new URL(imageUrl, base);
  } catch {
    return undefined;
  }
  return isAllowedImageUrl(url, githubHost) ? url.toString() : undefined;
}

/**
 * The bucket `github.com/user-attachments/assets/<uuid>` redirects to, named
 * in github.com's own `img-src` policy as a host it serves user attachments
 * from. Pinned exactly rather than as `*.s3.amazonaws.com`, which would let
 * any AWS customer's bucket through.
 */
const GITHUB_USER_ASSET_HOST =
  "github-production-user-asset-6210df.s3.amazonaws.com";

/**
 * HTTPS, no port, no embedded credentials, and a host GitHub serves pull
 * request images from: the pull request's own GitHub host, GitHub's asset
 * domain, or the user-attachment bucket above.
 */
function isAllowedImageUrl(url: URL, githubHost: GitHubHost): boolean {
  const hostname = normalizeHost(url.hostname);
  return (
    url.protocol === "https:" &&
    url.port === "" &&
    url.username === "" &&
    url.password === "" &&
    (hostname === normalizeHost(githubHost) ||
      hostname.endsWith(".githubusercontent.com") ||
      hostname === GITHUB_USER_ASSET_HOST)
  );
}

function isHost(imageUrl: string, githubHost: GitHubHost): boolean {
  try {
    return (
      normalizeHost(new URL(imageUrl).hostname) === normalizeHost(githubHost)
    );
  } catch {
    return false;
  }
}

function normalizeHost(host: string): string {
  return host.toLowerCase().replace(/\.$/, "");
}

function isRedirect(status: number): boolean {
  return (
    status === 301 ||
    status === 302 ||
    status === 303 ||
    status === 307 ||
    status === 308
  );
}

/**
 * Reads the body chunk by chunk and stops at `MAX_IMAGE_BYTES`, so an
 * oversized image is refused without ever being held whole in memory.
 */
async function readBoundedBody(
  response: Response,
): Promise<Result<Uint8Array, PullRequestImageFailure>> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_IMAGE_BYTES)
    return err({ reason: "invalid_result" });
  const body = response.body;
  if (body === null) return err({ reason: "github_read" });
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > MAX_IMAGE_BYTES) {
        await reader.cancel();
        return err({ reason: "invalid_result" });
      }
      chunks.push(chunk.value);
    }
  } catch {
    return err({ reason: "github_read" });
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return ok(bytes);
}
