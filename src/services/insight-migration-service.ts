import type {
  AnalysisShadowCheckpoint,
  AnalysisShadowFailure,
} from "#src/adapters/storage/insight-migration-store";
import { InsightStore } from "#src/adapters/storage/insight-store";
import type { PatchdeskPaths } from "#src/adapters/storage/patchdesk-paths";
import type { ReviewId, WorkspaceProfileId } from "#src/domain/ids";
import { err, ok, type Result } from "#src/domain/result";
import { spoolLegacyJson } from "./insight-legacy-json-spool";
import { LegacyJsonLexicalError } from "./insight-legacy-json-tokenizer";
import { resolveLegacyJsonProperties } from "./insight-legacy-json-resolver";
import { decodeLegacyJson } from "./insight-legacy-json-decoder";

/** Explicit shadow preparation has no worker, provider, startup hook or slot publication. */
export class InsightMigrationService {
  private readonly storage: InsightStore;

  constructor(paths: PatchdeskPaths) {
    this.storage = new InsightStore(paths);
  }

  /** Returns selected legacy properties with sensitive scanning and semantic conversion still pending. */
  async prepareAnalysisShadow(
    profileId: WorkspaceProfileId,
    reviewId: ReviewId,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<Result<AnalysisShadowCheckpoint, AnalysisShadowFailure>> {
    return this.storage.prepareAnalysisShadow(
      profileId,
      reviewId,
      async (source, files) => {
        try {
          const spool = await spoolLegacyJson(source, files.tokens, options);
          const structure = await decodeLegacyJson(files, options);
          if (structure._tag === "err")
            return err({
              _tag: "AnalysisShadowFailure",
              reason: structure.error.reason,
            });
          const properties = await resolveLegacyJsonProperties(
            files,
            structure.value,
            options,
          );
          if (properties._tag === "err")
            return err({
              _tag: "AnalysisShadowFailure",
              reason: properties.error.reason,
            });
          return ok({
            spool,
            structure: structure.value,
            properties: properties.value,
          });
        } catch (cause: unknown) {
          if (options.signal?.aborted)
            return err({ _tag: "AnalysisShadowFailure", reason: "cancelled" });
          if (cause instanceof LegacyJsonLexicalError)
            return err({
              _tag: "AnalysisShadowFailure",
              reason: "invalid_legacy",
            });
          if (cause instanceof RangeError)
            return err({
              _tag: "AnalysisShadowFailure",
              reason: "representation_exhausted",
            });
          return err({
            _tag: "AnalysisShadowFailure",
            reason: "storage_unavailable",
          });
        }
      },
      options,
    );
  }
}
