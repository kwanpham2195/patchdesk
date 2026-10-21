import * as v from "valibot";

import {
  guideGroupIdSchema,
  type GuideFileId,
  type GuideGroupId,
} from "./guide";
import type {
  GuideAddMembersInput,
  GuideOpenGroupInput,
  GuideOperationKind,
  GuideRefusalReason,
} from "./guide-protocol";
import {
  guideOperationPayloadSchemas,
  guideReceiptResultSchemas,
} from "./guide-protocol";
import {
  encodeInsightArtifactCanonicalJson,
  parseInsightArtifactCanonicalJson,
  type InsightCanonicalValue,
} from "./insight-artifact-scalars";
import { err, ok, type Result } from "./result";

type PayloadSchemas = typeof guideOperationPayloadSchemas;
/** A parsed operation payload for one kind: the model input plus the identity it was accepted under. */
export type GuideOperationPayload<K extends GuideOperationKind> = v.InferOutput<
  PayloadSchemas[K]
>;
/** Accepted receipt data for one kind. */
export type GuideReceiptResult<K extends GuideOperationKind> = v.InferOutput<
  (typeof guideReceiptResultSchemas)[K]
>;

type CanonicalSchema = v.GenericSchema<unknown, InsightCanonicalValue>;

/** Canonical JSON text of an operation payload; its UTF-8 bytes are what `payloadHash` covers. */
export function encodeGuideOperationPayload<K extends GuideOperationKind>(
  kind: K,
  payload: GuideOperationPayload<K>,
): string | undefined {
  const parsed = v.safeParse(guideOperationPayloadSchemas[kind], payload);
  // SAFETY: a parsed payload is a closed object of strings, integers and arrays of the same.
  const value = parsed.success
    ? (parsed.output as InsightCanonicalValue)
    : undefined;
  return value === undefined
    ? undefined
    : encodeInsightArtifactCanonicalJson(value);
}

/** Strict parse selected by the operation kind; noncanonical bytes are rejected. */
export function parseGuideOperationPayload<K extends GuideOperationKind>(
  kind: K,
  payloadText: string,
): Result<GuideOperationPayload<K>, "invalid_payload"> {
  // SAFETY: the registry maps each kind to its own closed schema, whose output is canonical JSON.
  const schema = guideOperationPayloadSchemas[kind] as CanonicalSchema;
  const parsed = parseInsightArtifactCanonicalJson(
    new TextEncoder().encode(payloadText),
    schema,
  );
  // SAFETY: `schema` is the schema selected by `kind`, so its output is that kind's payload.
  return parsed._tag === "ok"
    ? ok(parsed.value as GuideOperationPayload<K>)
    : err("invalid_payload");
}

/** Strict parse of a receipt result for its operation kind. */
export function parseGuideReceiptResult<K extends GuideOperationKind>(
  kind: K,
  resultText: string,
): Result<GuideReceiptResult<K>, "invalid_result"> {
  // SAFETY: the registry maps each kind to its own closed schema, whose output is canonical JSON.
  const schema = guideReceiptResultSchemas[kind] as CanonicalSchema;
  const parsed = parseInsightArtifactCanonicalJson(
    new TextEncoder().encode(resultText),
    schema,
  );
  // SAFETY: `schema` is the schema selected by `kind`, so its output is that kind's receipt result.
  return parsed._tag === "ok"
    ? ok(parsed.value as GuideReceiptResult<K>)
    : err("invalid_result");
}

/** Canonical text of a receipt result. */
export function encodeGuideReceiptResult<K extends GuideOperationKind>(
  kind: K,
  result: GuideReceiptResult<K>,
): string | undefined {
  const parsed = v.safeParse(guideReceiptResultSchemas[kind], result);
  // SAFETY: a parsed receipt result is a closed object of strings and integers.
  const value = parsed.success
    ? (parsed.output as InsightCanonicalValue)
    : undefined;
  return value === undefined
    ? undefined
    : encodeInsightArtifactCanonicalJson(value);
}

/** One accepted group as the app and the worker both derive it from the ordered operations. */
export type GuideBuiltGroup = {
  readonly id: GuideGroupId;
  readonly title: string;
  readonly explanation: string;
  readonly members: ReadonlyArray<{
    readonly fileId: GuideFileId;
    readonly relevance: string;
  }>;
};

type MutableGroup = {
  readonly id: GuideGroupId;
  readonly title: string;
  readonly explanation: string;
  readonly members: Array<{ fileId: GuideFileId; relevance: string }>;
  readonly files: Set<string>;
};

/**
 * The membership rules shared by the app (per accepted operation) and the worker (replay of every frozen receipt).
 * The app assigns `gN` in accepted-open order; file identities come from the complete prepared inventory.
 * A file may appear in several groups but only once within one, including across batches.
 */
export class GuideBuild {
  private readonly groups: Array<MutableGroup> = [];
  private readonly byId = new Map<string, MutableGroup>();
  private closed = false;

  constructor(private readonly inventory: ReadonlySet<string>) {}

  get isClosed(): boolean {
    return this.closed;
  }

  openGroup(
    input: Pick<GuideOpenGroupInput, "title" | "explanation">,
  ): Result<GuideReceiptResult<"open_group">, GuideRefusalReason> {
    if (this.closed) return err("closed");
    const id = v.parse(guideGroupIdSchema, `g${this.groups.length + 1}`);
    const group: MutableGroup = {
      id,
      title: input.title,
      explanation: input.explanation,
      members: [],
      files: new Set(),
    };
    this.groups.push(group);
    this.byId.set(id, group);
    return ok({ groupId: id });
  }

  /** Validates the whole batch before applying any member, so a refusal leaves the group unchanged. */
  addMembers(
    input: Pick<GuideAddMembersInput, "groupId" | "members">,
  ): Result<GuideReceiptResult<"add_members">, GuideRefusalReason> {
    if (this.closed) return err("closed");
    const group = this.byId.get(input.groupId);
    if (group === undefined) return err("unknown_group");
    const batch = new Set<string>();
    for (const member of input.members) {
      if (!this.inventory.has(member.fileId)) return err("unknown_file");
      if (group.files.has(member.fileId) || batch.has(member.fileId))
        return err("duplicate_member");
      batch.add(member.fileId);
    }
    for (const member of input.members) {
      group.files.add(member.fileId);
      group.members.push({
        fileId: member.fileId,
        relevance: member.relevance,
      });
    }
    return ok({
      groupId: group.id,
      accepted: input.members.length,
    });
  }

  /** Closes admission. A Guide needs a group, and every group needs a member, or nothing is closed. */
  finish(): Result<void, GuideRefusalReason> {
    if (this.closed) return err("closed");
    if (
      this.groups.length === 0 ||
      this.groups.some((group) => group.members.length === 0)
    )
      return err("invalid_input");
    this.closed = true;
    return ok(undefined);
  }

  snapshot(): ReadonlyArray<GuideBuiltGroup> {
    return this.groups.map((group) => ({
      id: group.id,
      title: group.title,
      explanation: group.explanation,
      members: group.members,
    }));
  }
}

/** Others is exactly the inventory entries absent from every group, in inventory order; it is never model output. */
export function guideOthersIds(
  inventoryIds: ReadonlyArray<string>,
  groups: ReadonlyArray<GuideBuiltGroup>,
): ReadonlyArray<string> {
  const included = new Set<string>(
    groups.flatMap((group) => group.members.map((member) => member.fileId)),
  );
  return inventoryIds.filter((id) => !included.has(id));
}
