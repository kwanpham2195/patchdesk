import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { processFile, type FileDiffMetadata } from "@pierre/diffs";
import * as v from "valibot";

import { requestJson } from "@/api-client";
import type { ReviewContextStatus } from "@/review-context-control";
import { definedProps } from "../../../domain/defined-props";
import type { RawJsonValue } from "../../../domain/json";
import {
  isUnifiedFileHeader,
  matchUnifiedFileHeader,
  tokenizeUnifiedPatchLines,
} from "../../../domain/unified-patch";

const HYDRATION_CONCURRENCY = 2;

// `@pierre/diffs` does not export `ProcessFileOptions` directly; derive it
// structurally from `processFile`'s own signature instead of duplicating it.
type ProcessFileOptions = NonNullable<Parameters<typeof processFile>[1]>;

export type ReviewDiffSourceSession = {
  readonly profileId: string;
  readonly sessionId: string;
};

type DiffFileContents = { readonly name: string; readonly contents: string };

type ReadyDiffSourceResponse = {
  readonly state: "ready";
  readonly oldFile?: DiffFileContents;
  readonly newFile?: DiffFileContents;
};

type DiffSourceResponse =
  | ReadyDiffSourceResponse
  | { readonly state: "unavailable"; readonly reason: string };

type HydrationSource = {
  readonly patch: string;
  readonly profileId?: string;
  readonly sessionId?: string;
};

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
  const sourceProfileId = sourceSession?.profileId;
  const sourceSessionId = sourceSession?.sessionId;
  const currentSource: HydrationSource = {
    patch,
    ...definedProps({
      profileId: sourceProfileId,
      sessionId: sourceSessionId,
    }),
  };
  const [hydrationSource, setHydrationSource] =
    useState<HydrationSource>(currentSource);
  const [hydrationGeneration, setHydrationGeneration] = useState(0);
  if (
    hydrationSource.patch !== currentSource.patch ||
    hydrationSource.profileId !== currentSource.profileId ||
    hydrationSource.sessionId !== currentSource.sessionId
  ) {
    setHydrationSource(currentSource);
    setHydrationGeneration((current) => current + 1);
    setHydratedFiles(new Map());
    setContextStatus("idle");
  }
  const hydrationRequests = useRef(
    new Map<
      string,
      { readonly token: symbol; readonly promise: Promise<boolean> }
    >(),
  );
  const hydratedFilesRef = useRef(hydratedFiles);
  const unavailableHydrationPaths = useRef(new Set<string>());
  const committedHydrationGeneration = useRef(hydrationGeneration);
  const hydratedFlushScheduled = useRef(false);
  const rawFilePatches = useMemo(() => splitPatch(patch), [patch]);
  const rawPatchesByPath = useMemo(
    () => indexPatchPaths(rawFilePatches),
    [rawFilePatches],
  );
  useLayoutEffect(() => {
    hydratedFilesRef.current = hydratedFiles;
  }, [hydratedFiles]);

  useLayoutEffect(() => {
    committedHydrationGeneration.current = hydrationGeneration;
    hydrationRequests.current.clear();
    unavailableHydrationPaths.current.clear();
  }, [hydrationGeneration]);

  // Concurrent hydration responses (up to HYDRATION_CONCURRENCY at once) each
  // land in their own microtask; flushing every one to React state would
  // re-render once per response and re-trigger CodeView's layout
  // invalidation mid-scroll. queueMicrotask (not requestAnimationFrame) still
  // fires before the tests' `await act(async () => { ...; await
  // Promise.all(...) })` resolves, since it's queued from inside the
  // response's own .then() before that handler's promise chain settles.
  const scheduleHydratedFlush = useCallback(() => {
    if (hydratedFlushScheduled.current) return;
    hydratedFlushScheduled.current = true;
    queueMicrotask(() => {
      hydratedFlushScheduled.current = false;
      setHydratedFiles(hydratedFilesRef.current);
    });
  }, []);

  const hydrateFile = useCallback(
    (path: string): Promise<boolean> => {
      if (hydratedFilesRef.current.has(path)) return Promise.resolve(true);
      if (unavailableHydrationPaths.current.has(path))
        return Promise.resolve(false);
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
        !isUnifiedFileHeader(rawFilePatch)
      ) {
        unavailableHydrationPaths.current.add(path);
        return Promise.resolve(false);
      }

      const generation = hydrationGeneration;
      const token = Symbol(path);
      const request = requestJson("/v1/reviews/diff-file", {
        method: "POST",
        body: { profileId: sourceProfileId, sessionId: sourceSessionId, path },
      })
        .then((value) => {
          if (generation !== committedHydrationGeneration.current) return false;
          const source = parseDiffSourceResponse(value);
          if (source?.state !== "ready") {
            unavailableHydrationPaths.current.add(path);
            return false;
          }
          const hydrateOptions: ProcessFileOptions = {};
          if (source.oldFile !== undefined)
            hydrateOptions.oldFile = source.oldFile;
          if (source.newFile !== undefined)
            hydrateOptions.newFile = source.newFile;
          const hydrated = processFile(rawFilePatch, hydrateOptions);
          if (hydrated === undefined) {
            unavailableHydrationPaths.current.add(path);
            return false;
          }
          const next = new Map(hydratedFilesRef.current);
          next.set(path, hydrated);
          hydratedFilesRef.current = next;
          scheduleHydratedFlush();
          return true;
        })
        .catch(() => {
          if (generation === committedHydrationGeneration.current) {
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
    [
      hydrationGeneration,
      patch,
      rawFilePatches,
      rawPatchesByPath,
      scheduleHydratedFlush,
      sourceProfileId,
      sourceSessionId,
    ],
  );

  const hydrateFiles = useCallback(
    async (paths: ReadonlyArray<string>): Promise<void> => {
      const pending = [...new Set(paths)].filter(
        (path) =>
          !hydratedFilesRef.current.has(path) &&
          !unavailableHydrationPaths.current.has(path),
      );
      for (
        let start = 0;
        start < pending.length;
        start += HYDRATION_CONCURRENCY
      ) {
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
    (selectedPath === undefined
      ? undefined
      : patchesByPath.get(selectedPath)) ??
    files[0] ??
    patch
  );
}

function splitPatch(patch: string): ReadonlyArray<string> {
  const lines = patch.split("\n");
  const starts = tokenizeUnifiedPatchLines(lines).flatMap((token) =>
    token.kind === "file_header" ? [token.index] : [],
  );
  return starts.map((start, order) =>
    lines.slice(start, starts[order + 1] ?? lines.length).join("\n"),
  );
}

function indexPatchPaths(
  patches: ReadonlyArray<string>,
): ReadonlyMap<string, string> {
  const indexed = new Map<string, string>();
  for (const patch of patches) {
    const header = matchUnifiedFileHeader(patch.split("\n", 1)[0] ?? "");
    if (header === undefined) continue;
    indexed.set(header.oldPath, patch);
    indexed.set(header.newPath, patch);
  }
  return indexed;
}

const diffFileContentsSchema = v.looseObject({
  name: v.string(),
  contents: v.string(),
});

// Loose at the envelope level so `reason`/`oldFile`/`newFile` can each be
// re-validated independently below: a malformed `oldFile` must not reject a
// response whose `newFile` is well-formed (and vice versa), so the two
// cannot be folded into one atomic object schema.
const diffSourceEnvelopeSchema = v.looseObject({
  state: v.string(),
  reason: v.optional(v.unknown()),
  oldFile: v.optional(v.unknown()),
  newFile: v.optional(v.unknown()),
});

function parseDiffSourceResponse(
  value: RawJsonValue | undefined,
): DiffSourceResponse | undefined {
  const envelope = v.safeParse(diffSourceEnvelopeSchema, value);
  if (!envelope.success) return undefined;
  const { state, reason, oldFile, newFile } = envelope.output;
  if (state === "unavailable") {
    const parsedReason = v.safeParse(v.string(), reason);
    return parsedReason.success
      ? { state: "unavailable", reason: parsedReason.output }
      : undefined;
  }
  if (state !== "ready") return undefined;
  const parsedOldFile = v.safeParse(diffFileContentsSchema, oldFile);
  const parsedNewFile = v.safeParse(diffFileContentsSchema, newFile);
  if (!parsedOldFile.success && !parsedNewFile.success) return undefined;
  return {
    state: "ready",
    ...definedProps({
      oldFile: parsedOldFile.success ? parsedOldFile.output : undefined,
      newFile: parsedNewFile.success ? parsedNewFile.output : undefined,
    }),
  };
}
