import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { processFile, type FileDiffMetadata } from "@pierre/diffs";

import { requestJson } from "@/api-client";
import type { ReviewContextStatus } from "@/review-context-control";

const HYDRATION_CONCURRENCY = 2;

export type ReviewDiffSourceSession = {
  readonly profileId: string;
  readonly sessionId: string;
};

type DiffSourceResponse =
  | {
      readonly state: "ready";
      readonly oldFile?: { readonly name: string; readonly contents: string };
      readonly newFile?: { readonly name: string; readonly contents: string };
    }
  | { readonly state: "unavailable"; readonly reason: string };

export type ReviewDiffHydration = {
  readonly hydratedFiles: ReadonlyMap<string, FileDiffMetadata>;
  readonly contextStatus: ReviewContextStatus;
  readonly rawFilePatches: ReadonlyArray<string>;
  readonly rawPatchesByPath: ReadonlyMap<string, string>;
  readonly hydrateFiles: (paths: ReadonlyArray<string>) => Promise<void>;
};

/**
 * Hydrates partial patches with the saved base/head contents. Request
 * de-duplication and generation checks keep a late response from replacing a
 * newer session's diff.
 */
export function useReviewDiffHydration({
  patch,
  sourceSession,
  selectedPath,
}: {
  readonly patch: string;
  readonly sourceSession?: ReviewDiffSourceSession;
  readonly selectedPath?: string;
}): ReviewDiffHydration {
  const [hydratedFiles, setHydratedFiles] = useState<
    ReadonlyMap<string, FileDiffMetadata>
  >(() => new Map());
  const [contextStatus, setContextStatus] =
    useState<ReviewContextStatus>("idle");
  const hydrationRequests = useRef(
    new Map<string, { readonly token: symbol; readonly promise: Promise<boolean> }>(),
  );
  const hydratedFilesRef = useRef(hydratedFiles);
  const unavailableHydrationPaths = useRef(new Set<string>());
  const hydrationGeneration = useRef(0);
  const rawFilePatches = useMemo(() => splitPatch(patch), [patch]);
  const rawPatchesByPath = useMemo(
    () => indexPatchPaths(rawFilePatches),
    [rawFilePatches],
  );
  const sourceProfileId = sourceSession?.profileId;
  const sourceSessionId = sourceSession?.sessionId;

  useEffect(() => {
    hydratedFilesRef.current = hydratedFiles;
  }, [hydratedFiles]);

  useEffect(() => {
    hydrationGeneration.current += 1;
    hydrationRequests.current.clear();
    unavailableHydrationPaths.current.clear();
    hydratedFilesRef.current = new Map();
    setHydratedFiles(new Map());
    setContextStatus("idle");
  }, [patch, sourceProfileId, sourceSessionId]);

  const hydrateFile = useCallback(
    (path: string): Promise<boolean> => {
      if (hydratedFilesRef.current.has(path)) return Promise.resolve(true);
      if (unavailableHydrationPaths.current.has(path)) return Promise.resolve(false);
      const existing = hydrationRequests.current.get(path);
      if (existing !== undefined) return existing.promise;

      const rawFilePatch = selectPatch(
        rawPatchesByPath,
        rawFilePatches,
        patch,
        path,
      );
      if (
        sourceProfileId === undefined ||
        sourceSessionId === undefined ||
        !rawFilePatch.startsWith("diff --git ")
      ) {
        unavailableHydrationPaths.current.add(path);
        return Promise.resolve(false);
      }

      const generation = hydrationGeneration.current;
      const token = Symbol(path);
      const request = requestJson("/v1/reviews/diff-file", {
        method: "POST",
        body: { profileId: sourceProfileId, sessionId: sourceSessionId, path },
      })
        .then((value) => {
          if (generation !== hydrationGeneration.current) return false;
          const source = parseDiffSourceResponse(value);
          if (source?.state !== "ready") {
            unavailableHydrationPaths.current.add(path);
            return false;
          }
          const hydrated = processFile(rawFilePatch, {
            ...(source.oldFile === undefined ? {} : { oldFile: source.oldFile }),
            ...(source.newFile === undefined ? {} : { newFile: source.newFile }),
          });
          if (hydrated === undefined) {
            unavailableHydrationPaths.current.add(path);
            return false;
          }
          const next = new Map(hydratedFilesRef.current);
          next.set(path, hydrated);
          hydratedFilesRef.current = next;
          setHydratedFiles(next);
          return true;
        })
        .catch(() => {
          if (generation === hydrationGeneration.current) {
            unavailableHydrationPaths.current.add(path);
          }
          return false;
        })
        .finally(() => {
          if (hydrationRequests.current.get(path)?.token === token) {
            hydrationRequests.current.delete(path);
          }
        });
      hydrationRequests.current.set(path, { token, promise: request });
      return request;
    },
    [patch, rawFilePatches, rawPatchesByPath, sourceProfileId, sourceSessionId],
  );

  const hydrateFiles = useCallback(
    async (paths: ReadonlyArray<string>): Promise<void> => {
      const pending = [...new Set(paths)].filter(
        (path) =>
          !hydratedFilesRef.current.has(path) &&
          !unavailableHydrationPaths.current.has(path),
      );
      for (let start = 0; start < pending.length; start += HYDRATION_CONCURRENCY) {
        await Promise.all(
          pending
            .slice(start, start + HYDRATION_CONCURRENCY)
            .map(async (path) => await hydrateFile(path)),
        );
      }
    },
    [hydrateFile],
  );

  useEffect(() => {
    if (
      selectedPath === undefined ||
      sourceProfileId === undefined ||
      sourceSessionId === undefined
    ) {
      setContextStatus("idle");
      return;
    }
    if (hydratedFilesRef.current.has(selectedPath)) {
      setContextStatus("ready");
      return;
    }
    let active = true;
    setContextStatus("loading");
    void hydrateFile(selectedPath).then((hydrated) => {
      if (active) setContextStatus(hydrated ? "ready" : "unavailable");
    });
    return () => {
      active = false;
    };
  }, [hydrateFile, selectedPath, sourceProfileId, sourceSessionId]);

  return {
    hydratedFiles,
    contextStatus,
    rawFilePatches,
    rawPatchesByPath,
    hydrateFiles,
  };
}

export function selectPatch(
  patchesByPath: ReadonlyMap<string, string>,
  files: ReadonlyArray<string>,
  patch: string,
  selectedPath: string | undefined,
): string {
  return (
    (selectedPath === undefined ? undefined : patchesByPath.get(selectedPath)) ??
    files[0] ??
    patch
  );
}

function splitPatch(patch: string): ReadonlyArray<string> {
  return patch
    .split(/(?=^diff --git )/m)
    .filter((value) => value.startsWith("diff --git "));
}

function indexPatchPaths(
  patches: ReadonlyArray<string>,
): ReadonlyMap<string, string> {
  const indexed = new Map<string, string>();
  for (const patch of patches) {
    const header = /^diff --git a\/(.+) b\/(.+)$/m.exec(patch);
    if (header === null) continue;
    const oldPath = header[1];
    const newPath = header[2];
    if (oldPath !== undefined) indexed.set(oldPath, patch);
    if (newPath !== undefined) indexed.set(newPath, patch);
  }
  return indexed;
}

function parseDiffSourceResponse(value: unknown): DiffSourceResponse | undefined {
  if (typeof value !== "object" || value === null || !("state" in value)) {
    return undefined;
  }
  const candidate = value as Record<string, unknown>;
  if (candidate.state === "unavailable" && typeof candidate.reason === "string") {
    return { state: "unavailable", reason: candidate.reason };
  }
  if (candidate.state !== "ready") return undefined;
  const parseFile = (
    input: unknown,
  ): { readonly name: string; readonly contents: string } | undefined =>
    typeof input === "object" &&
    input !== null &&
    "name" in input &&
    "contents" in input &&
    typeof input.name === "string" &&
    typeof input.contents === "string"
      ? { name: input.name, contents: input.contents }
      : undefined;
  const oldFile = parseFile(candidate.oldFile);
  const newFile = parseFile(candidate.newFile);
  if (oldFile === undefined && newFile === undefined) return undefined;
  return {
    state: "ready",
    ...(oldFile === undefined ? {} : { oldFile }),
    ...(newFile === undefined ? {} : { newFile }),
  };
}
