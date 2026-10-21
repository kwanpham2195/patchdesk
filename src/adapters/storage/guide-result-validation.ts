import type * as v from "valibot";

import type { guideInventoryEntrySchema } from "#src/domain/guide";
import type { GuideBuiltGroup } from "#src/domain/guide-result-records";
import {
  guideGroupCodec,
  guideInventoryEntryCodec,
  guideMemberCodec,
  guideResultRootCodec,
  guideValidationCodec,
  type GuideResultRoot,
} from "#src/domain/guide-result";
import type { ReviewId, WorkspaceProfileId } from "#src/domain/ids";
import type {
  InsightArtifactIndexDescriptor,
  InsightArtifactReference,
} from "#src/domain/insight-artifact-scalars";
import type { GuideResultStore } from "./guide-result-store";
import type { InsightArtifactStore } from "./insight-artifact-store";

const MAX_INVENTORY_BYTES = 64 * 1024 * 1024;

type InventoryEntry = v.InferOutput<typeof guideInventoryEntrySchema>;

/**
 * Writes the strict result graph derived by replay, then reads it back and compares it with what replay derived.
 * Every physical object is at most 16 KiB; long text lives behind TextRoots and member lists behind typed indexes.
 */
export class GuideGraphWriter {
  constructor(
    private readonly artifacts: InsightArtifactStore,
    private readonly store: GuideResultStore,
    private readonly profile: WorkspaceProfileId,
    private readonly review: ReviewId,
    private readonly identity: {
      readonly binding: InsightArtifactReference;
      readonly preparation: InsightArtifactReference;
      readonly generation: number;
      readonly cancelEpoch: number;
    },
    private readonly options: { readonly signal?: AbortSignal },
  ) {}

  async writeGraph(
    inventory: ReadonlyArray<InventoryEntry>,
    groups: ReadonlyArray<GuideBuiltGroup>,
    otherIds: ReadonlyArray<string>,
    frozen: {
      readonly sequence: number;
      readonly receipts: InsightArtifactIndexDescriptor;
    },
    completeness: GuideResultRoot["contextCompleteness"],
  ): Promise<
    | {
        readonly root: InsightArtifactReference;
        readonly validation: InsightArtifactReference;
        readonly others: number;
      }
    | "rejected"
    | undefined
  > {
    const { profile, review } = this;
    const text = async (value: string) => {
      const root = await this.artifacts.writeTextRoot(
        profile,
        review,
        value,
        this.options,
      );
      return root;
    };
    let [inventoryIndex, groupsIndex] = await Promise.all([
      this.store.emptyIndex("GuideInventoryEntry1"),
      this.store.emptyIndex("GuideGroup1"),
    ]);
    let othersIndex = inventoryIndex;
    if (
      inventoryIndex._tag === "err" ||
      othersIndex._tag === "err" ||
      groupsIndex._tag === "err"
    )
      return undefined;
    const others = new Set(otherIds);
    let otherOrdinal = 0;
    for (const [ordinal, entry] of inventory.entries()) {
      if (this.options.signal?.aborted) return undefined;
      const entryText = await text(JSON.stringify(entry));
      if (entryText._tag === "err")
        return entryText.error.reason === "sensitive_value"
          ? "rejected"
          : undefined;
      const record = await this.artifacts.writeObject(
        profile,
        review,
        guideInventoryEntryCodec,
        { fileId: entry.id, entry: entryText.value },
      );
      if (record._tag === "err") return undefined;
      inventoryIndex = await this.store.appendIndex(
        "GuideInventoryEntry1",
        inventoryIndex.value,
        ordinal,
        record.value,
      );
      if (inventoryIndex._tag === "err") return undefined;
      if (others.has(entry.id)) {
        othersIndex = await this.store.appendIndex(
          "GuideInventoryEntry1",
          othersIndex.value,
          otherOrdinal,
          record.value,
        );
        otherOrdinal += 1;
        if (othersIndex._tag === "err") return undefined;
      }
    }
    for (const [groupOrdinal, group] of groups.entries()) {
      if (this.options.signal?.aborted) return undefined;
      const [title, explanation] = await Promise.all([
        text(group.title),
        text(group.explanation),
      ]);
      if (title._tag === "err" || explanation._tag === "err") {
        const sensitive =
          (title._tag === "err" && title.error.reason === "sensitive_value") ||
          (explanation._tag === "err" &&
            explanation.error.reason === "sensitive_value");
        return sensitive ? "rejected" : undefined;
      }
      let members = await this.store.emptyIndex("GuideMember1");
      for (const [memberOrdinal, member] of group.members.entries()) {
        if (members._tag === "err") return undefined;
        const relevance = await text(member.relevance);
        if (relevance._tag === "err")
          return relevance.error.reason === "sensitive_value"
            ? "rejected"
            : undefined;
        const record = await this.artifacts.writeObject(
          profile,
          review,
          guideMemberCodec,
          { fileId: member.fileId, relevance: relevance.value },
        );
        if (record._tag === "err") return undefined;
        members = await this.store.appendIndex(
          "GuideMember1",
          members.value,
          memberOrdinal,
          record.value,
        );
      }
      if (members._tag === "err") return undefined;
      const stored = await this.artifacts.writeObject(
        profile,
        review,
        guideGroupCodec,
        {
          id: group.id,
          title: title.value,
          explanation: explanation.value,
          members: members.value,
        },
      );
      if (stored._tag === "err") return undefined;
      groupsIndex = await this.store.appendIndex(
        "GuideGroup1",
        groupsIndex.value,
        groupOrdinal,
        stored.value,
      );
      if (groupsIndex._tag === "err") return undefined;
    }
    const validation = await this.artifacts.writeObject(
      profile,
      review,
      guideValidationCodec,
      {
        binding: this.identity.binding,
        preparation: this.identity.preparation,
        generation: this.identity.generation,
        cancelEpoch: this.identity.cancelEpoch,
        frozenSequence: frozen.sequence,
        receipts: frozen.receipts,
        groups: groupsIndex.value,
        inventory: inventoryIndex.value,
        others: othersIndex.value,
        validator: "guide-membership-v1",
      },
    );
    if (validation._tag === "err") return undefined;
    const root = await this.artifacts.writeObject(
      profile,
      review,
      guideResultRootCodec,
      {
        binding: this.identity.binding,
        preparation: this.identity.preparation,
        frozenSequence: frozen.sequence,
        receipts: frozen.receipts,
        groups: groupsIndex.value,
        inventory: inventoryIndex.value,
        others: othersIndex.value,
        validation: validation.value,
        contextCompleteness: completeness,
      },
    );
    return root._tag === "err"
      ? undefined
      : {
          root: root.value,
          validation: validation.value,
          others: otherOrdinal,
        };
  }

  /** Reads the stored graph back and compares it with what replay derived; a mismatch is a storage failure. */
  async readBack(
    rootReference: InsightArtifactReference,
    inventory: ReadonlyArray<InventoryEntry>,
    groups: ReadonlyArray<GuideBuiltGroup>,
  ): Promise<boolean> {
    const { profile, review } = this;
    const root = await this.artifacts.readObject(
      profile,
      review,
      guideResultRootCodec,
      rootReference,
    );
    if (root._tag === "err") return false;
    if (
      root.value.groups.count !== groups.length ||
      root.value.inventory.count !== inventory.length
    )
      return false;
    const storedGroups = await this.store.readWholeIndex(
      "GuideGroup1",
      root.value.groups,
    );
    if (storedGroups._tag === "err") return false;
    for (const [at, entry] of storedGroups.value.entries()) {
      if (this.options.signal?.aborted) return false;
      const expected = groups[at];
      // react-doctor-disable-next-line react-doctor/async-await-in-loop -- readback is bounded by the group count
      const group = await this.artifacts.readObject(
        profile,
        review,
        guideGroupCodec,
        entry.value,
      );
      if (
        expected === undefined ||
        group._tag === "err" ||
        group.value.id !== expected.id ||
        group.value.members.count !== expected.members.length
      )
        return false;
      const [title, explanation, members] = await Promise.all([
        this.store.readText(group.value.title, 4_000 * 4),
        this.store.readText(group.value.explanation, 4_000 * 4),
        this.store.readWholeIndex("GuideMember1", group.value.members),
      ]);
      if (
        title._tag === "err" ||
        explanation._tag === "err" ||
        members._tag === "err" ||
        title.value !== expected.title ||
        explanation.value !== expected.explanation
      )
        return false;
      for (const [memberAt, memberEntry] of members.value.entries()) {
        const expectedMember = expected.members[memberAt];
        // react-doctor-disable-next-line react-doctor/async-await-in-loop -- members verify in order
        const member = await this.artifacts.readObject(
          profile,
          review,
          guideMemberCodec,
          memberEntry.value,
        );
        if (
          expectedMember === undefined ||
          member._tag === "err" ||
          member.value.fileId !== expectedMember.fileId
        )
          return false;
        const relevance = await this.store.readText(
          member.value.relevance,
          500 * 4,
        );
        if (
          relevance._tag === "err" ||
          relevance.value !== expectedMember.relevance
        )
          return false;
      }
    }
    const records = await this.store.readWholeIndex(
      "GuideInventoryEntry1",
      root.value.inventory,
    );
    if (records._tag === "err") return false;
    for (const [at, entry] of records.value.entries()) {
      if (this.options.signal?.aborted) return false;
      const expected = inventory[at];
      // react-doctor-disable-next-line react-doctor/async-await-in-loop -- inventory readback is ordered
      const record = await this.artifacts.readObject(
        profile,
        review,
        guideInventoryEntryCodec,
        entry.value,
      );
      if (
        expected === undefined ||
        record._tag === "err" ||
        record.value.fileId !== expected.id
      )
        return false;
      const stored = await this.store.readText(
        record.value.entry,
        MAX_INVENTORY_BYTES,
      );
      if (stored._tag === "err" || stored.value !== JSON.stringify(expected))
        return false;
    }
    return true;
  }
}
