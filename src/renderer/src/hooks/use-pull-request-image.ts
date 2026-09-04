import { useEffect, useState } from "react";
import * as v from "valibot";

import type { PullRequestRef } from "../../../domain/pull-request";
import { requestJson } from "../api-client";
import { useLatestCommitted } from "./use-latest-committed";

/** Everything the main process needs to decide whether one image may be fetched. */
export type PullRequestImageSource = {
  readonly profileId: string;
  readonly pullRequest: PullRequestRef;
};

export type PullRequestImageState =
  | { readonly _tag: "Pending" }
  | { readonly _tag: "Ready"; readonly dataUri: string }
  | { readonly _tag: "Failed" };

const imageResponseSchema = v.object({
  dataUri: v.pipe(v.string(), v.startsWith("data:")),
});

/**
 * One resolution per profile, pull request and source URL, so the same image
 * shown twice — a re-render, a second copy in the body, a remount while
 * scrolling — costs one bridge call. A failed resolution is dropped from the
 * map so a later view retries rather than being stuck on the placeholder.
 */
const resolutions = new Map<string, Promise<string>>();

/**
 * Resolves one image referenced by a pull request body into a `data:` URI.
 * The bytes have to come back through the main process: the renderer's
 * `img-src 'self' data:` CSP blocks an `<img>` pointing at GitHub directly.
 *
 * Nothing is requested until `visible` is true, so an image inside a closed
 * `<details>` or far below the fold costs nothing until it is shown.
 */
export function usePullRequestImage(input: {
  readonly source: PullRequestImageSource | undefined;
  readonly src: string;
  readonly visible: boolean;
}): PullRequestImageState {
  const { source, src, visible } = input;
  const key = source === undefined ? undefined : requestKey(source, src);
  const latestSource = useLatestCommitted(source);
  const [state, setState] = useState<PullRequestImageState>({
    _tag: "Pending",
  });

  useEffect(() => {
    const committed = latestSource.current;
    if (key === undefined || committed === undefined) {
      setState({ _tag: "Failed" });
      return;
    }
    if (!visible) return;
    let active = true;
    setState({ _tag: "Pending" });
    resolveImage(committed, src)
      .then((dataUri) => {
        if (active) setState({ _tag: "Ready", dataUri });
      })
      .catch(() => {
        if (active) setState({ _tag: "Failed" });
      });
    return () => {
      active = false;
    };
  }, [key, latestSource, src, visible]);

  return state;
}

function resolveImage(
  source: PullRequestImageSource,
  src: string,
): Promise<string> {
  const key = requestKey(source, src);
  const existing = resolutions.get(key);
  if (existing !== undefined) return existing;
  const resolution = requestImage(source, src).catch((cause: unknown) => {
    resolutions.delete(key);
    throw cause;
  });
  resolutions.set(key, resolution);
  return resolution;
}

async function requestImage(
  source: PullRequestImageSource,
  src: string,
): Promise<string> {
  const value = await requestJson("/v1/reviews/markdown-image", {
    method: "POST",
    body: {
      profileId: source.profileId,
      host: source.pullRequest.host,
      owner: source.pullRequest.owner,
      repo: source.pullRequest.repo,
      number: source.pullRequest.number,
      url: src,
    },
  });
  const parsed = v.safeParse(imageResponseSchema, value);
  if (!parsed.success) throw new Error("Invalid pull request image response");
  return parsed.output.dataUri;
}

function requestKey(source: PullRequestImageSource, src: string): string {
  const { host, owner, repo, number } = source.pullRequest;
  return [source.profileId, host, owner, repo, number, src].join("\u0000");
}
