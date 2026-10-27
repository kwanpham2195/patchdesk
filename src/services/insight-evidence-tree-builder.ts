import { resolve, win32 } from "node:path";

import { isPathContained } from "#src/adapters/storage/path-containment";
import { buildGuideInventory } from "#src/domain/guide";
import type {
  InsightEvidenceBundle,
  InsightEvidenceFailure,
  InsightEvidenceIdentity,
  EvidenceSource,
} from "#src/domain/insight-evidence";
import { parseNarrativePatch } from "#src/domain/narrative-patch";
import { iterateUnifiedPatch } from "#src/domain/unified-patch";
import { err, ok, type Result } from "#src/domain/result";
import { hashReviewArtifactContent } from "./review-artifact-hash";

/** Splits captured patch bytes without normalizing line endings or file order. */
export function buildInsightEvidenceTree(input: {
  readonly identity: InsightEvidenceIdentity;
  readonly directory: string;
  readonly patch: string;
  readonly context: string;
  readonly reviewInput: string;
  readonly snapshots: Readonly<Record<string, string>>;
  readonly snapshotSkips: Readonly<Record<string, string>>;
}): Result<InsightEvidenceBundle, InsightEvidenceFailure> {
  const inventory =
    input.patch.length === 0 ? ok([]) : buildGuideInventory(input.patch);
  const parsed = parseNarrativePatch(input.patch);
  const headers: Array<{ readonly offset: number; readonly quoted: boolean }> =
    [];
  let offset = 0;
  for (const token of iterateUnifiedPatch(input.patch)) {
    if (token.kind === "file_header")
      headers.push({ offset, quoted: token.raw.includes('"') });
    offset += token.raw.length + 1;
  }
  if (
    inventory._tag === "err" ||
    (input.patch.length > 0 && headers[0]?.offset !== 0) ||
    headers.length !== inventory.value.length ||
    (parsed._tag === "err" && /\n@@ /.test(input.patch))
  )
    return err({ _tag: "InsightEvidenceFailure", reason: "evidence_mismatch" });
  const hunks = parsed._tag === "ok" ? parsed.value.files : [];
  const hunksByOrdinal = new Map(hunks.map((entry) => [entry.ordinal, entry]));
  const sources: Array<EvidenceSource> = [];
  const directories = new Set(["diff", "head", "context"]);
  const put = (name: string, text: string) => {
    let parent = name.slice(0, name.lastIndexOf("/"));
    while (name.includes("/") && parent.length > 0) {
      directories.add(parent);
      parent = parent.includes("/")
        ? parent.slice(0, parent.lastIndexOf("/"))
        : "";
    }
    sources.push({
      id: `s${sources.length + 1}`,
      name,
      text,
      sha256: hashReviewArtifactContent(text),
    });
  };
  const assigned = new Map<
    string,
    { readonly name: string; readonly kind: "file" | "directory" }
  >();
  const snapshots: Array<{ readonly path: string; readonly name: string }> = [];
  const diffs: string[] = [];
  const files = inventory.value.map((file, index) => {
    const header = headers[index];
    const text = input.patch.slice(header?.offset, headers[index + 1]?.offset);
    const path = file.newPath;
    const candidateNames = [`diff/${path}.diff`, `head/${path}`];
    const safe =
      header?.quoted === false &&
      safeEvidencePath(path) &&
      path.split("/")[0]?.toLowerCase() !== "_unrepresentable" &&
      candidateNames.every((name) => evidencePathFits(name, assigned));
    const mapped = safe ? path : `_unrepresentable/${file.id}`;
    const diff = `diff/${mapped}.diff`;
    const head = `head/${mapped}`;
    for (const name of [diff, head]) {
      const segments = name.split("/");
      for (let count = 1; count <= segments.length; count += 1) {
        const prefix = segments.slice(0, count).join("/");
        assigned.set(prefix.normalize("NFC").toLowerCase(), {
          name: prefix,
          kind: count === segments.length ? "file" : "directory",
        });
      }
    }
    put(diff, text);
    diffs.push(diff);
    const nonregular = file.metadata.some((line) =>
      /^(?:(?:new file mode|new mode) |index [0-9a-f]+\.\.[0-9a-f]+ )(120000|160000)$/.test(
        line,
      ),
    );
    const snapshot = Object.hasOwn(input.snapshots, path)
      ? input.snapshots[path]
      : undefined;
    const reason =
      file.status === "removed"
        ? "deleted"
        : nonregular
          ? "nonregular"
          : file.evidence === "binary"
            ? "binary"
            : file.evidence === "submodule"
              ? "nonregular"
              : Object.hasOwn(input.snapshotSkips, path)
                ? input.snapshotSkips[path]
                : "unavailable";
    const captured =
      snapshot !== undefined &&
      !nonregular &&
      file.evidence !== "binary" &&
      file.evidence !== "submodule" &&
      file.status !== "removed";
    if (captured) {
      put(head, snapshot);
      snapshots.push({ path, name: head });
    }
    return {
      ...file,
      diff,
      pathMapping: safe ? "repository" : "unrepresentable",
      hunks: hunksByOrdinal.get(index)?.hunks.map((hunk) => hunk.id) ?? [],
      snapshot: captured
        ? { state: "captured", path: head }
        : { state: "skipped", reason },
    };
  });
  const sourceText = new Map(
    sources.map((source) => [source.name, source.text]),
  );
  if (
    hashReviewArtifactContent(
      diffs.map((name) => sourceText.get(name) ?? "").join(""),
    ) !== input.identity.patchHash
  )
    return err({ _tag: "InsightEvidenceFailure", reason: "evidence_mismatch" });
  put("files.json", JSON.stringify(files));
  put(
    "hunks.json",
    JSON.stringify(
      hunks.flatMap((file) =>
        file.hunks.map(({ raw: _raw, filePrefix: _prefix, ...hunk }) => ({
          ...hunk,
          fileId: `f${file.ordinal + 1}`,
        })),
      ),
    ),
  );
  put("context/review-context.json", input.context);
  put("context/review-input.md", input.reviewInput);
  put(
    "README.md",
    "Captured Analysis evidence. Start with files.json, then read every diff/ file. Open head/ only for surrounding code; skipped snapshots and their reasons are in files.json. No base blobs are captured. Binary files, symlinks and submodules have metadata only, never head text. Context contains the captured review context and review input. Cite repository path, side and source line for Analysis findings. hunks.json maps canonical hN hunks to fN files. Physical diff-file lines are not citations. files.json records any path stored under _unrepresentable/fN. manifest.json is a reading aid; the host retains the authoritative file set and digests.\n",
  );
  const treeFiles = sources.map(({ name, text, sha256 }) => ({
    name,
    bytes: Buffer.byteLength(text),
    sha256,
  }));
  const bundleId = hashReviewArtifactContent(
    JSON.stringify({ identity: input.identity, files: treeFiles }),
  );
  const manifestText = JSON.stringify({
    format: "insight-evidence-tree/1",
    identity: input.identity,
    bundleId,
    directories: [...directories],
    files: treeFiles,
  });
  put("manifest.json", manifestText);
  return ok({
    identity: input.identity,
    directory: input.directory,
    bundleId,
    sources,
    pages: [],
    manifestText,
    tree: {
      format: "insight-evidence-tree/1",
      directories: [...directories],
      files: sources.map(({ name, text, sha256 }) => ({
        name,
        bytes: Buffer.byteLength(text),
        sha256,
      })),
      diffs,
      snapshots,
    },
  });
}

function safeEvidencePath(path: string): boolean {
  return (
    path.length > 0 &&
    !win32.isAbsolute(path) &&
    !/^[a-z]:/i.test(path) &&
    !path.includes("\\") &&
    [...path].every(
      (character) =>
        character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127,
    ) &&
    path
      .split("/")
      .every(
        (segment) =>
          segment !== "" &&
          segment !== "." &&
          segment !== ".." &&
          Buffer.byteLength(segment) <= 240,
      ) &&
    !path.startsWith("/") &&
    isPathContained(resolve("evidence"), resolve("evidence", path))
  );
}

function evidencePathFits(
  name: string,
  assigned: ReadonlyMap<
    string,
    { readonly name: string; readonly kind: "file" | "directory" }
  >,
): boolean {
  const segments = name.split("/");
  return segments.every((_, index) => {
    const prefix = segments.slice(0, index + 1).join("/");
    const entry = assigned.get(prefix.normalize("NFC").toLowerCase());
    return (
      entry === undefined ||
      (index < segments.length - 1 &&
        entry.kind === "directory" &&
        entry.name === prefix)
    );
  });
}
