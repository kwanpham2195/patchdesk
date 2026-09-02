import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

const MIB = 1024 * 1024;

export const PACKAGE_SIZE_LIMITS_MIB = Object.freeze({
  asar: 30,
  insightRuntime: 30,
  app: 360,
  dmg: 135,
  zip: 145,
});

/**
 * Measures the five shipped macOS artifacts and rejects missing, empty, or
 * oversized output. Directory sizes are the sum of regular file bytes;
 * symlinks are not followed, so the result is deterministic across filesystems.
 *
 * @param {{ bundle: string; dmg: string; zip: string }} paths
 * @param {{ asar: number; insightRuntime: number; app: number; dmg: number; zip: number }} [limitsMiB]
 */
export async function validatePackageSizes(
  paths,
  limitsMiB = PACKAGE_SIZE_LIMITS_MIB,
) {
  const artifacts = [
    {
      name: "app.asar",
      path: join(paths.bundle, "Contents", "Resources", "app.asar"),
      kind: "file",
      limitMiB: limitsMiB.asar,
    },
    {
      name: "insight-runtime",
      path: join(paths.bundle, "Contents", "Resources", "insight-runtime"),
      kind: "directory",
      limitMiB: limitsMiB.insightRuntime,
    },
    {
      name: "Patchdesk.app",
      path: paths.bundle,
      kind: "directory",
      limitMiB: limitsMiB.app,
    },
    { name: "DMG", path: paths.dmg, kind: "file", limitMiB: limitsMiB.dmg },
    { name: "ZIP", path: paths.zip, kind: "file", limitMiB: limitsMiB.zip },
  ];

  const measurements = [];
  for (const artifact of artifacts) {
    if (!Number.isFinite(artifact.limitMiB) || artifact.limitMiB <= 0)
      throw new Error(
        `${artifact.name} has an invalid size limit: ${String(artifact.limitMiB)} MiB`,
      );
    const bytes = await artifactBytes(artifact);
    if (bytes === 0)
      throw new Error(`${artifact.name} is empty: ${artifact.path}`);
    const limitBytes = artifact.limitMiB * MIB;
    if (bytes > limitBytes)
      throw new Error(
        `${artifact.name} measured ${formatMiB(bytes)} MiB (${bytes} bytes), limit ${artifact.limitMiB.toFixed(2)} MiB (${limitBytes} bytes)`,
      );
    measurements.push({
      name: artifact.name,
      path: artifact.path,
      bytes,
      measuredMiB: bytes / MIB,
      limitMiB: artifact.limitMiB,
    });
  }
  return measurements;
}

/** @param {{ name: string; path: string; kind: string }} artifact */
async function artifactBytes(artifact) {
  let metadata;
  try {
    metadata = await stat(artifact.path);
  } catch (cause) {
    if (Object(cause).code === "ENOENT")
      throw new Error(`${artifact.name} is missing: ${artifact.path}`, {
        cause,
      });
    throw cause;
  }
  if (artifact.kind === "file") {
    if (!metadata.isFile())
      throw new Error(`${artifact.name} is not a file: ${artifact.path}`);
    return metadata.size;
  }
  if (!metadata.isDirectory())
    throw new Error(`${artifact.name} is not a directory: ${artifact.path}`);
  return await directoryBytes(artifact.path);
}

/** @param {string} root */
async function directoryBytes(root) {
  let bytes = 0;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) bytes += await directoryBytes(path);
    else if (entry.isFile()) bytes += (await stat(path)).size;
  }
  return bytes;
}

/** @param {number} bytes */
function formatMiB(bytes) {
  return (bytes / MIB).toFixed(2);
}
