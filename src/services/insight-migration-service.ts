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
import { scanLegacyJsonSensitiveData } from "./insight-legacy-json-sensitive-scan";
import { checkLegacyAnalysisRoot } from "./insight-legacy-analysis-root-shape";
import { readLegacyJsonNumber } from "./insight-legacy-json-number";
import * as v from "valibot";

const schemaVersion = v.literal(2);
const nextToken = v.pipe(v.number(), v.integer(), v.minValue(1));

/** Explicit shadow preparation has no worker, provider, startup hook or slot publication. */
export class InsightMigrationService {
  private readonly storage: InsightStore;

  constructor(paths: PatchdeskPaths) {
    this.storage = new InsightStore(paths);
  }

  /** Checks root shape and its two numbers; nested schemas, numeric conversion and equality remain pending. */
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
          const sensitive = await scanLegacyJsonSensitiveData(
            files,
            structure.value,
            properties.value,
            options,
          );
          if (sensitive._tag === "err")
            return err({
              _tag: "AnalysisShadowFailure",
              reason: sensitive.error.reason,
            });
          const root = await checkLegacyAnalysisRoot(
            files,
            structure.value,
            properties.value,
            reviewId,
            options,
          );
          if (root._tag === "err")
            return err({
              _tag: "AnalysisShadowFailure",
              reason: root.error.reason,
            });
          for (const [id, schema] of [
            [root.value.schemaVersion, schemaVersion],
            [root.value.nextToken, nextToken],
          ] as const) {
            const number = await readLegacyJsonNumber(
              files.structure,
              structure.value,
              id,
              options,
            );
            if (number._tag === "err")
              return err({
                _tag: "AnalysisShadowFailure",
                reason: number.error.reason,
              });
            if (!v.safeParse(schema, number.value).success)
              return err({
                _tag: "AnalysisShadowFailure",
                reason: "invalid_legacy",
              });
          }
          return ok({
            state: "analysis_root_numbers_checked",
            pending: "nested_schema_numeric_conversion_equality",
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
