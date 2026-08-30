import { gzipSync } from "node:zlib";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import { validateRendererFontBundle } from "./font-package-validation.mjs";

const rendererRoot = join(process.cwd(), "out/renderer");
const graph = JSON.parse(
  await readFile(join(rendererRoot, "renderer-graph.json"), "utf8"),
);
const assetNames = await readdir(join(rendererRoot, "assets"));
const cssSources = await Promise.all(
  assetNames
    .filter((fileName) => fileName.endsWith(".css"))
    .map((fileName) =>
      readFile(join(rendererRoot, "assets", fileName), "utf8"),
    ),
);
const fontErrors = validateRendererFontBundle(
  assetNames.map((fileName) => `assets/${fileName}`),
  cssSources.join("\n"),
);
if (fontErrors.length > 0) throw new Error(fontErrors.join("\n"));
const chunks = new Map(graph.chunks.map((chunk) => [chunk.fileName, chunk]));
const entries = graph.chunks.filter((chunk) => chunk.isEntry);
if (entries.length !== 1)
  throw new Error(`Expected one renderer entry, found ${entries.length}`);
const entry = entries[0];
const staticClosure = reachable(entry.fileName, (chunk) => chunk.imports);
const reviewChunks = graph.chunks.filter(
  (chunk) =>
    chunk.isDynamicEntry &&
    chunk.modules.some((id) =>
      id.endsWith("/src/renderer/src/flows/review-workbench-flow.tsx"),
    ),
);
const fixtureChunks = graph.chunks.filter(
  (chunk) =>
    chunk.isDynamicEntry &&
    chunk.modules.some((id) =>
      id.endsWith("/src/renderer/src/flows/app-fixtures.tsx"),
    ),
);
if (reviewChunks.length !== 1)
  throw new Error(
    `Expected one dynamic Review flow chunk, found ${reviewChunks.length}`,
  );
if (fixtureChunks.length !== 1)
  throw new Error(
    `Expected one dynamic fixture route chunk, found ${fixtureChunks.length}`,
  );
const forbidden = [
  "/src/renderer/src/flows/review-workbench-flow.tsx",
  "/src/renderer/src/flows/app-fixtures.tsx",
  "/src/renderer/src/components/review-workbench.tsx",
  "/node_modules/@pierre/diffs/",
  "/node_modules/@pierre+diffs@",
  "/node_modules/@pierre/trees/",
  "/node_modules/@pierre+trees@",
  "/node_modules/@pierre/theming/",
  "/node_modules/@pierre+theming@",
  "/node_modules/@shikijs/",
  "/node_modules/@shikijs+",
  "/node_modules/shiki/",
  "/node_modules/.pnpm/shiki@",
  "/node_modules/marked/",
  "/node_modules/.pnpm/marked@",
  "/node_modules/mermaid/",
  "/node_modules/.pnpm/mermaid@",
];
for (const fileName of staticClosure) {
  const chunk = chunks.get(fileName);
  if (chunk === undefined) throw new Error(`Missing emitted chunk ${fileName}`);
  for (const moduleId of chunk.modules) {
    if (forbidden.some((needle) => moduleId.includes(needle)))
      throw new Error(
        `Renderer entry statically reaches heavy module ${moduleId}`,
      );
  }
}
const review = reviewChunks[0];
const [entryBytes, reviewBytes] = await Promise.all([
  readFile(join(rendererRoot, entry.fileName)),
  readFile(join(rendererRoot, review.fileName)),
]);
console.log(
  JSON.stringify(
    {
      entry: entry.fileName,
      entryRawBytes: entryBytes.byteLength,
      entryGzipBytes: gzipSync(entryBytes).byteLength,
      reviewChunk: review.fileName,
      reviewRawBytes: reviewBytes.byteLength,
      reviewGzipBytes: gzipSync(reviewBytes).byteLength,
      staticChunks: staticClosure.size,
      separation: "passed",
      fonts: "passed",
    },
    null,
    2,
  ),
);

function reachable(start, children) {
  const visited = new Set();
  const pending = [start];
  while (pending.length > 0) {
    const fileName = pending.pop();
    if (fileName === undefined || visited.has(fileName)) continue;
    const chunk = chunks.get(fileName);
    if (chunk === undefined)
      throw new Error(`Missing emitted chunk ${fileName}`);
    visited.add(fileName);
    for (const child of children(chunk)) pending.push(child);
  }
  return visited;
}
