import * as v from "valibot";

import { parseRepoRelativePath } from "./ids";
import { err, ok, type Result } from "./result";
import { iterateUnifiedPatch } from "./unified-patch";

/** Prepared inventory identity `fN`, assigned in patch order by Patchdesk. */
export const guideFileIdSchema = v.pipe(
  v.string(),
  v.regex(/^f[1-9]\d*$/),
  v.brand("GuideFileId"),
);
/** Group identity `gN`, assigned by Patchdesk in accepted-open order. */
export const guideGroupIdSchema = v.pipe(
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
/** Existing per-field limits: 200, 4000 and 500 characters; there is no total group or membership cap. */
export const guideTitleSchema = nonblank(200);
export const guideExplanationSchema = nonblank(4_000);
export const guideRelevanceSchema = nonblank(500);
const fileIdSchema = guideFileIdSchema;
const groupIdSchema = guideGroupIdSchema;
const membershipSchema = v.strictObject({
  fileId: fileIdSchema,
  relevance: guideRelevanceSchema,
});
const groupFields = {
  title: guideTitleSchema,
  explanation: guideExplanationSchema,
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
/** One complete inventory entry, including its metadata lines. */
export const guideInventoryEntrySchema = v.strictObject({
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
  inventory: v.pipe(v.array(guideInventoryEntrySchema), v.minLength(1)),
  groups: v.pipe(
    v.array(v.strictObject({ id: groupIdSchema, ...groupFields })),
    v.minLength(1),
    v.maxLength(12),
  ),
});
/** Branded `fN` and `gN` identities. */
export type GuideFileId = v.InferOutput<typeof guideFileIdSchema>;
export type GuideGroupId = v.InferOutput<typeof guideGroupIdSchema>;
/** Complete metadata for one patch file block. */
export type GuideInventoryEntry = v.InferOutput<
  typeof guideInventoryEntrySchema
>;
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
  const inventory: Array<GuideInventoryEntry> = [];
  let file: Omit<GuideInventoryEntry, "id"> | undefined;
  const finishFile = (): boolean => {
    if (file === undefined) return true;
    const entry = v.safeParse(guideInventoryEntrySchema, {
      ...file,
      id: `f${inventory.length + 1}`,
    });
    if (!entry.success) return false;
    inventory.push(entry.output);
    return true;
  };
  for (const token of iterateUnifiedPatch(patchText)) {
    if (token.kind === "file_header") {
      if (
        !finishFile() ||
        token.oldPath === undefined ||
        token.newPath === undefined ||
        parseRepoRelativePath(token.oldPath)._tag === "err" ||
        parseRepoRelativePath(token.newPath)._tag === "err"
      )
        return err({ reason: "patch_not_indexable" });
      file = {
        oldPath: token.oldPath,
        newPath: token.newPath,
        status: "modified",
        evidence: "metadata",
        additions: 0,
        deletions: 0,
        metadata: [],
      };
    }
    if (file === undefined) continue;
    if (token.kind === "rename_from" || token.kind === "rename_to")
      file.status = "renamed";
    if (token.kind === "old_file_path" && token.path === "/dev/null")
      file.status = "added";
    if (token.kind === "new_file_path" && token.path === "/dev/null")
      file.status = "removed";
    if (token.kind === "other" && token.raw.startsWith("new file mode "))
      file.status = "added";
    if (token.kind === "other" && token.raw.startsWith("deleted file mode "))
      file.status = "removed";
    if (token.kind === "binary" || token.raw === "GIT binary patch")
      file.evidence = "binary";
    else if (token.kind === "omitted") file.evidence = "omitted";
    else if (token.kind === "submodule") file.evidence = "submodule";
    else if (token.kind === "hunk_header" && file.evidence === "metadata")
      file.evidence = "text";
    if (token.kind === "body" && token.marker === "added") file.additions += 1;
    if (token.kind === "body" && token.marker === "removed")
      file.deletions += 1;
    if (
      token.kind !== "body" &&
      token.kind !== "hunk_header" &&
      token.raw.length > 0
    )
      file.metadata.push(token.raw);
  }
  if (!finishFile() || inventory.length === 0)
    return err({ reason: "patch_not_indexable" });
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
