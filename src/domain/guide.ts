import * as v from "valibot";

import { parseRepoRelativePath } from "./ids";
import { err, ok, type Result } from "./result";
import { tokenizeUnifiedPatch } from "./unified-patch";

const fileIdSchema = v.pipe(
  v.string(),
  v.regex(/^f[1-9]\d*$/),
  v.brand("GuideFileId"),
);
const groupIdSchema = v.pipe(
  v.string(),
  v.regex(/^g[1-9]\d*$/),
  v.brand("GuideGroupId"),
);
const nonblank = (limit: number) =>
  v.pipe(
    v.string(),
    v.maxLength(limit),
    v.check((value) => value.trim().length > 0),
  );
const membershipSchema = v.strictObject({
  fileId: fileIdSchema,
  relevance: nonblank(500),
});
const groupFields = {
  title: nonblank(200),
  explanation: nonblank(4_000),
  files: v.pipe(v.array(membershipSchema), v.minLength(1)),
};
/** Strict model contract; all evidence and identities are attached by Patchdesk. */
export const guideModelOutputSchema = v.strictObject({
  groups: v.pipe(
    v.array(v.strictObject(groupFields)),
    v.minLength(1),
    v.maxLength(12),
  ),
});
const inventoryEntrySchema = v.strictObject({
  id: fileIdSchema,
  oldPath: v.string(),
  newPath: v.string(),
  status: v.picklist(["added", "removed", "renamed", "modified"]),
  additions: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
  deletions: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
  evidence: v.picklist(["text", "binary", "metadata", "omitted", "submodule"]),
  metadata: v.array(v.string()),
});
/** Self-contained Guide evidence, validated again when storage or the renderer reads it. */
export const retainedGuideSchema = v.strictObject({
  patchText: v.string(),
  inventory: v.pipe(v.array(inventoryEntrySchema), v.minLength(1)),
  groups: v.pipe(
    v.array(v.strictObject({ id: groupIdSchema, ...groupFields })),
    v.minLength(1),
    v.maxLength(12),
  ),
});
/** Complete metadata for one patch file block. */
export type GuideInventoryEntry = v.InferOutput<typeof inventoryEntrySchema>;
/** Stored result includes its immutable evidence. */
export type RetainedGuide = v.InferOutput<typeof retainedGuideSchema>;
/** Invalid evidence or model output never produces a partial Guide. */
export type GuideError = {
  readonly reason: "invalid_result" | "patch_not_indexable";
};

/** Includes header-only, binary, renamed and deleted entries in patch order. */
export function buildGuideInventory(
  patchText: string,
): Result<ReadonlyArray<GuideInventoryEntry>, GuideError> {
  const tokens = tokenizeUnifiedPatch(patchText);
  const headers = tokens.filter((token) => token.kind === "file_header");
  if (headers.length === 0) return err({ reason: "patch_not_indexable" });
  const inventory: Array<GuideInventoryEntry> = [];
  for (const [index, header] of headers.entries()) {
    if (header.oldPath === undefined || header.newPath === undefined)
      return err({ reason: "patch_not_indexable" });
    const block = tokens.slice(
      header.index,
      headers[index + 1]?.index ?? tokens.length,
    );
    const oldPath = header.oldPath;
    const newPath = header.newPath;
    let status: GuideInventoryEntry["status"] = "modified";
    let evidence: GuideInventoryEntry["evidence"] = "metadata";
    let additions = 0;
    let deletions = 0;
    const metadata: Array<string> = [];
    for (const token of block) {
      if (token.kind === "rename_from") {
        status = "renamed";
      }
      if (token.kind === "rename_to") {
        status = "renamed";
      }
      if (token.kind === "old_file_path" && token.path === "/dev/null")
        status = "added";
      if (token.kind === "new_file_path" && token.path === "/dev/null")
        status = "removed";
      if (token.kind === "other" && token.raw.startsWith("new file mode "))
        status = "added";
      if (token.kind === "other" && token.raw.startsWith("deleted file mode "))
        status = "removed";
      if (token.kind === "binary" || token.raw === "GIT binary patch")
        evidence = "binary";
      else if (token.kind === "omitted") evidence = "omitted";
      else if (token.kind === "submodule") evidence = "submodule";
      else if (token.kind === "hunk_header" && evidence === "metadata")
        evidence = "text";
      if (token.kind === "body" && token.marker === "added") additions += 1;
      if (token.kind === "body" && token.marker === "removed") deletions += 1;
      if (
        token.kind !== "body" &&
        token.kind !== "hunk_header" &&
        token.raw.length > 0
      )
        metadata.push(token.raw);
    }
    if (
      parseRepoRelativePath(oldPath)._tag === "err" ||
      parseRepoRelativePath(newPath)._tag === "err"
    )
      return err({ reason: "patch_not_indexable" });
    const entry = v.safeParse(inventoryEntrySchema, {
      id: `f${index + 1}`,
      oldPath,
      newPath,
      status,
      evidence,
      additions,
      deletions,
      metadata,
    });
    if (!entry.success) return err({ reason: "patch_not_indexable" });
    inventory.push(entry.output);
  }
  return ok(inventory);
}

/** Validates only model-owned fields against the captured complete inventory. */
export function parseGuideModelOutput(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- this parser validates provider JSON or stored JSON at its owning input boundary.
  input: unknown,
  inventory: ReadonlyArray<GuideInventoryEntry>,
): Result<v.InferOutput<typeof guideModelOutputSchema>, GuideError> {
  const parsed = v.safeParse(guideModelOutputSchema, input);
  if (!parsed.success || !validMemberships(parsed.output.groups, inventory))
    return err({ reason: "invalid_result" });
  return ok(parsed.output);
}

/** Attaches immutable evidence and assigns group IDs after strict validation. */
export function retainGuide(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- this parser validates provider JSON or stored JSON at its owning input boundary.
  input: unknown,
  evidence: {
    readonly patchText: string;
    readonly inventory: ReadonlyArray<GuideInventoryEntry>;
  },
): Result<RetainedGuide, GuideError> {
  const parsed = parseGuideModelOutput(input, evidence.inventory);
  if (parsed._tag === "err") return parsed;
  return parseRetainedGuide({
    patchText: evidence.patchText,
    inventory: evidence.inventory,
    groups: parsed.value.groups.map((group, index) => ({
      id: `g${index + 1}`,
      ...group,
    })),
  });
}

/** Stored inventory must exactly represent the embedded bytes, including metadata. */
export function parseRetainedGuide(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- this parser validates provider JSON or stored JSON at its owning input boundary.
  input: unknown,
): Result<RetainedGuide, GuideError> {
  const parsed = v.safeParse(retainedGuideSchema, input);
  if (!parsed.success) return err({ reason: "invalid_result" });
  if (
    new TextEncoder().encode(parsed.output.patchText).length >
      2 * 1024 * 1024 ||
    new TextEncoder().encode(JSON.stringify(parsed.output.inventory)).length >
      512 * 1024
  )
    return err({ reason: "invalid_result" });
  const inventory = buildGuideInventory(parsed.output.patchText);
  if (
    inventory._tag === "err" ||
    JSON.stringify(inventory.value) !==
      JSON.stringify(parsed.output.inventory) ||
    !validMemberships(parsed.output.groups, parsed.output.inventory) ||
    parsed.output.groups.some((group, index) => group.id !== `g${index + 1}`)
  )
    return err({ reason: "invalid_result" });
  return ok(parsed.output);
}

/** Others contains exactly entries absent from every group. */
export function guideOthers(
  guide: RetainedGuide,
): ReadonlyArray<GuideInventoryEntry> {
  const included = new Set(
    guide.groups.flatMap((group) => group.files.map((file) => file.fileId)),
  );
  return guide.inventory.filter((file) => !included.has(file.id));
}

function validMemberships(
  groups: ReadonlyArray<
    v.InferOutput<typeof guideModelOutputSchema>["groups"][number]
  >,
  inventory: ReadonlyArray<GuideInventoryEntry>,
): boolean {
  const ids = new Set(inventory.map((file) => file.id));
  return groups.every(
    (group) =>
      group.files.length <= inventory.length &&
      new Set(group.files.map((file) => file.fileId)).size ===
        group.files.length &&
      group.files.every((file) => ids.has(file.fileId)),
  );
}
