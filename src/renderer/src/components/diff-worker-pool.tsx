/// <reference types="vite/client" />
import type { ReactNode } from "react";
import {
  WorkerPoolContextProvider,
  type WorkerInitializationRenderOptions,
  type WorkerPoolOptions,
} from "@pierre/diffs/react";
// The bundler-driven worker build (imports bare specifiers, ~59 KB) rather
// than worker-portable.js (451 KB, for URL-driven loading without a
// bundler). The `?worker` suffix routes this through Vite's separate
// nested worker build instead of the main renderer bundle.
import DiffSyntaxWorker from "@pierre/diffs/worker/worker.js?worker";

/**
 * Languages the workbench renders most often. Preloading these into the
 * shared highlighter avoids a per-file grammar fetch on first paint for the
 * common case; any other language still resolves lazily on first use.
 */
const PRELOADED_LANGUAGES: WorkerInitializationRenderOptions["langs"] = [
  "typescript",
  "tsx",
  "javascript",
  "jsx",
  "json",
];

const POOL_OPTIONS: WorkerPoolOptions = {
  workerFactory: () => new DiffSyntaxWorker(),
};

const HIGHLIGHTER_OPTIONS: WorkerInitializationRenderOptions = {
  langs: PRELOADED_LANGUAGES,
  // Patchdesk bundles locally (no single-file constraint), so the faster
  // WASM engine is preferred over the JS-only shiki-js fallback.
  preferredHighlighter: "shiki-wasm",
};

/**
 * Mounts `@pierre/diffs`' worker pool so syntax colouring for virtualized
 * diff views runs off the main thread instead of blocking scroll frames.
 * `useTokenTransformer` is deliberately left unset: patchdesk has no
 * token-level interactions (no `onToken*` handlers, no code-navigation by
 * click), and that option costs extra work per token for nothing.
 */
export function DiffWorkerPoolProvider({
  children,
}: {
  readonly children: ReactNode;
}): React.JSX.Element {
  // jsdom (the renderer unit-test environment `DiffWorkbench` also renders
  // under) has no global `Worker`. Skip mounting the pool there so tests get
  // the same main-thread fallback `useWorkerPool()` already returns when no
  // provider is mounted, instead of the pool's async worker initialization
  // throwing "Worker is not defined".
  if (globalThis.Worker === undefined) return <>{children}</>;
  return (
    <WorkerPoolContextProvider
      poolOptions={POOL_OPTIONS}
      highlighterOptions={HIGHLIGHTER_OPTIONS}
    >
      {children}
    </WorkerPoolContextProvider>
  );
}
