#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * One model as the generated catalog records it.
 *
 * @typedef {object} CatalogModel
 * @property {string} name The provider's display label for the model.
 * @property {string} provider The provider id the model belongs to.
 */

/**
 * A parsed catalog: the Pi version that generated it, and its models keyed by
 * `provider/id`.
 *
 * @typedef {object} ParsedCatalog
 * @property {string} version
 * @property {ReadonlyMap<string, CatalogModel>} models
 */

/**
 * A model whose label changed while its `provider/id` key stayed put.
 *
 * @typedef {object} LabelChange
 * @property {string} key
 * @property {string} from
 * @property {string} to
 */

/**
 * A removed key and the added key that looks like the same model under a new
 * id scheme.
 *
 * @typedef {object} LikelyRename
 * @property {string} from
 * @property {string} to
 */

/**
 * One provider whose model count moved between the two catalogs.
 *
 * @typedef {object} ProviderChange
 * @property {string} provider
 * @property {number} before
 * @property {number} after
 */

/**
 * Everything that moved between two generated catalogs.
 *
 * @typedef {object} CatalogDelta
 * @property {string} oldVersion
 * @property {string} newVersion
 * @property {number} oldCount
 * @property {number} newCount
 * @property {number} oldProviderCount
 * @property {number} newProviderCount
 * @property {ReadonlyArray<string>} added
 * @property {ReadonlyArray<string>} removed
 * @property {ReadonlyArray<LabelChange>} renamed
 * @property {ReadonlyArray<LikelyRename>} moves
 * @property {ReadonlyArray<ProviderChange>} providerChanges
 */

const MODEL_PATTERN =
  /id:\s*"([^"]+)",\s*name:\s*"([^"]+)",\s*provider:\s*"([^"]+)"/g;

/**
 * Read the models out of a generated catalog's source text.
 *
 * The generated file is thousands of lines of object literals, so this reads
 * the three fields that identify a model rather than importing the module.
 *
 * @param {string} text
 * @returns {ParsedCatalog}
 */
function parseCatalog(text) {
  /** @type {Map<string, CatalogModel>} */
  const models = new Map();
  for (const match of text.matchAll(MODEL_PATTERN)) {
    const [, id, name, provider] = match;
    if (id === undefined || name === undefined || provider === undefined)
      continue;
    models.set(`${provider}/${id}`, { name, provider });
  }
  const version = /piVersion:\s*"([^"]+)"/.exec(text)?.[1] ?? "?";
  return { version, models };
}

/**
 * Count a catalog's models per provider.
 *
 * @param {ReadonlyMap<string, CatalogModel>} models
 * @returns {ReadonlyMap<string, number>}
 */
function countByProvider(models) {
  /** @type {Map<string, number>} */
  const counts = new Map();
  for (const { provider } of models.values())
    counts.set(provider, (counts.get(provider) ?? 0) + 1);
  return counts;
}

/**
 * Strip the punctuation and the middle path segment an id scheme change moves,
 * so `anthropic/claude-x` and `anthropic/vendor/claude.x` normalise alike.
 *
 * @param {string} key
 * @returns {string}
 */
function normalizeKey(key) {
  return key
    .toLowerCase()
    .replace(/[-._]/g, "")
    .replace(/^([^/]+\/)[^/]+\//, "$1");
}

/**
 * Compare two generated catalogs by their model id sets.
 *
 * `git diff` on the generated file is thousands of lines; the review that
 * matters is which ids appeared, which vanished, and which vanished only to
 * come back under a new id scheme. That last case is the dangerous one: a
 * saved `defaultModel` or `enabledModels` entry naming the old id silently
 * stops matching.
 *
 * @param {string} oldText Source of the catalog being replaced.
 * @param {string} newText Source of the regenerated catalog.
 * @returns {CatalogDelta}
 */
export function diffCatalogs(oldText, newText) {
  const before = parseCatalog(oldText);
  const after = parseCatalog(newText);

  const added = [...after.models.keys()]
    .filter((key) => !before.models.has(key))
    .sort();
  const removed = [...before.models.keys()]
    .filter((key) => !after.models.has(key))
    .sort();

  /** @type {LabelChange[]} */
  const renamed = [];
  for (const key of [...after.models.keys()].sort()) {
    const from = before.models.get(key)?.name;
    const to = after.models.get(key)?.name;
    if (from !== undefined && to !== undefined && from !== to)
      renamed.push({ key, from, to });
  }

  const addedByNormalized = new Map(
    added.map((key) => [normalizeKey(key), key]),
  );
  /** @type {LikelyRename[]} */
  const moves = [];
  for (const from of removed) {
    const to = addedByNormalized.get(normalizeKey(from));
    if (to !== undefined) moves.push({ from, to });
  }

  const beforeCounts = countByProvider(before.models);
  const afterCounts = countByProvider(after.models);
  const providers = [
    ...new Set([...beforeCounts.keys(), ...afterCounts.keys()]),
  ].sort();
  /** @type {ProviderChange[]} */
  const providerChanges = [];
  for (const provider of providers) {
    const beforeCount = beforeCounts.get(provider) ?? 0;
    const afterCount = afterCounts.get(provider) ?? 0;
    if (beforeCount !== afterCount)
      providerChanges.push({
        provider,
        before: beforeCount,
        after: afterCount,
      });
  }

  return {
    oldVersion: before.version,
    newVersion: after.version,
    oldCount: before.models.size,
    newCount: after.models.size,
    oldProviderCount: beforeCounts.size,
    newProviderCount: afterCounts.size,
    added,
    removed,
    renamed,
    moves,
    providerChanges,
  };
}

/**
 * Render one titled list, or nothing when the list is empty.
 *
 * @param {string} title
 * @param {ReadonlyArray<string>} entries
 * @returns {ReadonlyArray<string>}
 */
function section(title, entries) {
  if (entries.length === 0) return [];
  return ["", `${title}:`, ...entries.map((entry) => `  ${entry}`)];
}

/**
 * Render the delta as the report the upgrade procedure reads.
 *
 * @param {CatalogDelta} delta
 * @returns {string}
 */
function formatCatalogDelta(delta) {
  const lines = [
    `Pi ${delta.oldVersion} -> ${delta.newVersion}: ${delta.oldCount} -> ${delta.newCount} models, ${delta.oldProviderCount} -> ${delta.newProviderCount} providers`,
    `added ${delta.added.length}, removed ${delta.removed.length}, renamed ${delta.renamed.length}`,
    "",
    "Per provider (old -> new):",
    ...delta.providerChanges.map(({ provider, before, after }) => {
      const note =
        before === 0
          ? "  NEW PROVIDER"
          : after === 0
            ? "  REMOVED PROVIDER"
            : "";
      return `  ${provider}: ${before} -> ${after}${note}`;
    }),
    ...section("Added", delta.added),
    ...section("Removed", delta.removed),
    ...section(
      "Renamed (label only)",
      delta.renamed.map(({ key, from, to }) => `${key}: "${from}" -> "${to}"`),
    ),
    ...section(
      "Likely id renames (old -> new; saved defaults naming the old id stop matching)",
      delta.moves.map(({ from, to }) => `${from} -> ${to}`),
    ),
  ];
  return lines.join("\n");
}

function main() {
  const oldPath = process.argv[2];
  const newPath = process.argv[3];
  if (oldPath === undefined || newPath === undefined) {
    process.stderr.write(
      "Usage: pnpm pi:catalog-delta <old.generated.ts> <new.generated.ts>, for example pnpm pi:catalog-delta /tmp/old-catalog.ts src/adapters/pi/pi-ai-catalog.generated.ts\n",
    );
    process.exitCode = 2;
    return;
  }

  const delta = diffCatalogs(
    readFileSync(resolve(oldPath), "utf8"),
    readFileSync(resolve(newPath), "utf8"),
  );
  process.stdout.write(`${formatCatalogDelta(delta)}\n`);
}

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  resolve(invokedPath) === fileURLToPath(import.meta.url)
)
  main();
