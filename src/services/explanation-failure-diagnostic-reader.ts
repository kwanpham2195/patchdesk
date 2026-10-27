import { opendir } from "node:fs/promises";
import * as v from "valibot";
import { insightArtifactRunIdSchema } from "#src/domain/insight-artifact-scalars";
import type { InsightArtifactStore } from "#src/adapters/storage/insight-artifact-store";
import type {
  InsightRunJournalReader,
  InsightJournalSnapshot,
} from "#src/adapters/storage/insight-run-journal-reader";
import type { PatchdeskPaths } from "#src/adapters/storage/patchdesk-paths";
import {
  EXPLANATION_FAILURE_DETAILS,
  type ExplanationFailureDiagnostic,
} from "#src/domain/insight-failure-diagnostic";
import {
  insightAuthorizationCodec,
  insightBindingCodec,
  insightDomainIdentityCodec,
  insightFailureRecordCodec,
  type insightLegacyFailureCodec,
  insightProvenanceCodec,
} from "#src/domain/insight-run-binding-contract";
import { parseInsightJournalPointer } from "#src/domain/insight-run-journal-contract";
import { err, ok, type Result } from "#src/domain/result";
import type { InsightSlotKey } from "./insight-slot-records";

type Scope = InsightSlotKey & { readonly runId: string };
type Failure = v.InferOutput<typeof insightLegacyFailureCodec.schema>;
type Diagnostic = ExplanationFailureDiagnostic | undefined;
type ReadResult = Result<Diagnostic, "invalid_result" | "storage_unavailable">;

/** Reads fixed native failure labels from the existing terminal journal without native history. */
export class ExplanationFailureDiagnosticReader {
  constructor(
    private readonly paths: PatchdeskPaths,
    private readonly artifacts: InsightArtifactStore,
    private readonly journals: InsightRunJournalReader,
  ) {}

  /** Exact identity and failure agreement are required before fixed application text becomes a public label. */
  async read(scope: Scope, failure: Failure): Promise<ReadResult> {
    if (
      (failure.provider !== "codex-cli-account" &&
        failure.provider !== "pi-cli-account") ||
      failure.reason !== "failed"
    )
      return ok(undefined);
    const runId = v.safeParse(insightArtifactRunIdSchema, scope.runId);
    if (!runId.success) return err("invalid_result");
    let matched = false;
    let diagnostic: Diagnostic;
    try {
      const directory = await opendir(
        this.paths.insightJournalsDirectory(scope.profileId, scope.reviewId),
      );
      for await (const entry of directory) {
        if (
          !this.paths.isInsightJournalEntryName(entry.name) ||
          entry.name.endsWith(".intent.json")
        )
          continue;
        const journal = {
          ...scope,
          runId: runId.output,
          journalId: entry.name.slice(0, -5),
        };
        // Sequential bounded pointer reads avoid materializing unrelated journals or directory contents.
        const bytes = await this.journals.readPointerBytes(journal);
        if (bytes._tag === "err") return err("storage_unavailable");
        if (bytes.value === null) continue;
        const pointer = parseInsightJournalPointer(bytes.value);
        if (pointer._tag === "err") return err("invalid_result");
        if (pointer.value.runId !== scope.runId) continue;
        if (matched) return err("invalid_result");
        matched = true;
        const snapshot = await this.journals.read(journal);
        if (snapshot._tag === "err") return err("invalid_result");
        const selected = await this.fromJournal(scope, failure, snapshot.value);
        if (selected._tag === "err") return selected;
        diagnostic = selected.value;
      }
      return ok(diagnostic);
    } catch {
      return err("storage_unavailable");
    }
  }

  private async fromJournal(
    scope: Scope,
    failure: Failure,
    snapshot: InsightJournalSnapshot,
  ): Promise<ReadResult> {
    const { profileId, reviewId, runId, type } = scope;
    const { state } = snapshot;
    if (
      state.status !== "failed" ||
      state.failure === null ||
      failure.category === undefined
    )
      return ok(undefined);
    const binding = await this.artifacts.readObject(
      profileId,
      reviewId,
      insightBindingCodec,
      state.binding,
    );
    if (binding._tag === "err" || binding.value.kind !== type)
      return err("invalid_result");
    const identity = await this.artifacts.readObject(
      profileId,
      reviewId,
      insightDomainIdentityCodec,
      binding.value.identity,
    );
    if (identity._tag === "err") return err("invalid_result");
    for (const [root, expected] of [
      [identity.value.profileId, profileId],
      [identity.value.reviewId, reviewId],
      [identity.value.runId, runId],
      [failure.runId, runId],
    ] as const) {
      const same = await this.artifacts.verifyTextRootEquals(
        profileId,
        reviewId,
        root,
        expected,
      );
      if (same._tag === "err") return err("invalid_result");
    }
    const record = await this.artifacts.readObject(
      profileId,
      reviewId,
      insightFailureRecordCodec,
      state.failure,
    );
    if (record._tag === "err") return err("invalid_result");
    if (
      record.value.phase !== "generation" ||
      record.value.at !== failure.failedAt ||
      record.value.recovery !== "terminal" ||
      record.value.detail === undefined
    )
      return ok(undefined);
    const authorization = await this.artifacts.readObject(
      profileId,
      reviewId,
      insightAuthorizationCodec,
      state.authorization,
    );
    if (
      authorization._tag === "err" ||
      authorization.value.runId !== runId ||
      authorization.value.policy.hash !== state.policy.hash
    )
      return err("invalid_result");
    const selection = await this.artifacts.readObject(
      profileId,
      reviewId,
      insightProvenanceCodec,
      authorization.value.selection,
    );
    if (
      selection._tag === "err" ||
      selection.value.provider !== failure.provider ||
      selection.value.reasoning !== failure.reasoning ||
      selection.value.model.data.sha256 !== failure.model.data.sha256
    )
      return err("invalid_result");
    const diagnostic =
      record.value.code === "capability_unavailable" &&
      failure.provider === "codex-cli-account"
        ? "unsupported_codex_version"
        : record.value.code === "unresolved_work"
          ? "provider_completed_without_finish"
          : undefined;
    if (diagnostic === undefined) return ok(undefined);
    const category = await this.artifacts.verifyTextRootEquals(
      profileId,
      reviewId,
      failure.category,
      diagnostic === "unsupported_codex_version"
        ? "runtime_unavailable"
        : "unexpected_failure",
    );
    if (category._tag === "err") return err("invalid_result");
    const detail = await this.artifacts.textRootEquals(
      profileId,
      reviewId,
      record.value.detail,
      EXPLANATION_FAILURE_DETAILS[diagnostic],
    );
    return detail._tag === "err"
      ? err("invalid_result")
      : ok(detail.value ? diagnostic : undefined);
  }
}
