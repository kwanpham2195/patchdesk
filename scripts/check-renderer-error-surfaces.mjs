import { readdirSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const APPROVED_ALERT_ROLE_PATHS = new Set([
  "src/renderer/src/components/ui/alert.tsx",
  "src/renderer/src/components/ui/field.tsx",
  "src/renderer/src/components/ui/inline-error.tsx",
]);
const LITERAL_ALERT_ROLE =
  /\brole\s*=\s*(?:"alert"|'alert'|\{\s*(?:"alert"|'alert')\s*\})/g;

/** @typedef {{ readonly path: string; readonly source: string }} RendererSource */
/** @typedef {{ readonly path: string; readonly line: number }} ErrorSurfaceViolation */

/**
 * Finds raw literal alert roles in renderer sources that do not own an approved primitive.
 *
 * @param {ReadonlyArray<RendererSource>} sources
 * @returns {ReadonlyArray<ErrorSurfaceViolation>}
 */
export function scanRendererErrorSurfaceSources(sources) {
  const violations = [];
  for (const sourceFile of sources) {
    const normalizedPath = sourceFile.path.replaceAll("\\", "/");
    if (APPROVED_ALERT_ROLE_PATHS.has(normalizedPath)) continue;

    for (const match of sourceFile.source.matchAll(LITERAL_ALERT_ROLE)) {
      const index = match.index;
      if (index === undefined) continue;
      violations.push({
        path: normalizedPath,
        line: sourceFile.source.slice(0, index).split("\n").length,
      });
    }
  }
  return violations;
}

/**
 * Scans the production renderer below an explicit repository root.
 *
 * @param {string} root
 * @returns {ReadonlyArray<ErrorSurfaceViolation>}
 */
export function scanRendererErrorSurfaces(root) {
  const rendererRoot = resolve(root, "src/renderer/src");
  const paths = collectTsxFiles(rendererRoot);
  return scanRendererErrorSurfaceSources(
    paths.map((path) => ({
      path: relative(root, path),
      source: readFileSync(path, "utf8"),
    })),
  );
}

/**
 * @param {string} directory
 * @returns {ReadonlyArray<string>}
 */
function collectTsxFiles(directory) {
  const paths = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) paths.push(...collectTsxFiles(path));
    else if (entry.isFile() && entry.name.endsWith(".tsx")) paths.push(path);
  }
  return paths.sort();
}

function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const violations = scanRendererErrorSurfaces(root);
  if (violations.length === 0) {
    process.stdout.write("Renderer error surfaces use approved primitives.\n");
    return;
  }

  process.stderr.write(
    `${violations.map(({ path, line }) => `${path}:${line} raw role="alert"; use Alert, FieldError, or InlineError`).join("\n")}\n`,
  );
  process.exitCode = 1;
}

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  resolve(invokedPath) === fileURLToPath(import.meta.url)
)
  main();
