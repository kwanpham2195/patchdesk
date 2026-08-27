import { discoverPathOnlyExecutable } from "../adapters/process/executable-discovery";
import type {
  InsightProvider,
  InsightReasoning,
  InsightSelection,
} from "../domain/insight-provider";
import { err, ok, type Result } from "../domain/result";
import type {
  CodexAppServerClient,
  CodexAppServerFailure,
  CodexModel,
} from "../adapters/codex/codex-app-server-client";
import type { PiRuntimeModelCatalog } from "../adapters/pi/pi-runtime-model-catalog";
import { canonicalModelId } from "../adapters/pi/pi-runtime-model-catalog";

/** Renderer-safe provider availability. It never contains a path or account detail. */
type InsightProviderStatus = {
  readonly id: InsightProvider;
  readonly label: string;
  readonly available: boolean;
  readonly guidance: string;
};

/** Provider-specific model metadata used only by Insight dialogs. */
type InsightProviderModel = {
  readonly provider: InsightProvider;
  readonly id: string;
  readonly label: string;
  readonly reasoning: ReadonlyArray<InsightReasoning>;
  readonly defaultReasoning?: InsightReasoning;
};

/** Complete passive or activated Insight provider catalog. */
export type InsightProviderCatalogSnapshot = {
  readonly providers: ReadonlyArray<InsightProviderStatus>;
  readonly models: ReadonlyArray<InsightProviderModel>;
};

export type InsightProviderCatalogFailure = {
  readonly _tag: "InsightProviderCatalogUnavailable";
  readonly reason:
    | "runtime_unavailable"
    | "authentication_required"
    | "rate_limited"
    | "timed_out"
    | "invalid_result";
};

/** The catalog only ever lists models, so it asks for only that one method. */
type CodexClientFactory = (
  executablePath: string,
) => Pick<CodexAppServerClient, "listModels">;

/** Coordinates passive status, explicit Codex discovery, and exact run validation. */
export class InsightProviderCatalog {
  private readonly codexClientFactory: CodexClientFactory;
  private readonly executableResolver: (
    name: string,
  ) => Promise<string | undefined>;

  constructor(
    private readonly pi: PiRuntimeModelCatalog,
    clientFactory: CodexClientFactory,
    executableResolver: (name: string) => Promise<string | undefined> = (
      name,
    ) => discoverPathOnlyExecutable(name),
  ) {
    this.codexClientFactory = clientFactory;
    this.executableResolver = executableResolver;
  }

  /** Returns provider statuses and Pi models without starting Codex. */
  async passive(): Promise<
    Result<InsightProviderCatalogSnapshot, InsightProviderCatalogFailure>
  > {
    const [piResult, codexPath] = await Promise.all([
      this.pi.get(),
      this.executableResolver("codex"),
    ]);
    const piModels =
      piResult._tag === "ok"
        ? piResult.value.models.map((model) => ({
            provider: "pi" as const,
            id: model.id,
            label: model.label,
            reasoning: ["low", "medium", "high"] as const,
            defaultReasoning: "medium" as const,
          }))
        : [];
    return ok({
      providers: [
        {
          id: "pi",
          label: "Pi",
          available: piResult._tag === "ok",
          guidance:
            "Configure an eligible Pi provider in the Electron process.",
        },
        {
          id: "codex-cli-account",
          label: "Codex CLI account",
          available: codexPath !== undefined,
          guidance:
            codexPath === undefined
              ? "Install Codex and expose codex on the app launch PATH, then log in externally."
              : "Use the existing local Codex CLI login.",
        },
      ],
      models: piModels,
    });
  }

  /** Explicitly starts a throwaway Codex app server and loads its live models. */
  async activateCodex(): Promise<
    Result<InsightProviderCatalogSnapshot, InsightProviderCatalogFailure>
  > {
    const executablePath = await this.executableResolver("codex");
    if (executablePath === undefined)
      return err({
        _tag: "InsightProviderCatalogUnavailable",
        reason: "runtime_unavailable",
      });
    const result = await this.codexClientFactory(executablePath).listModels();
    if (result._tag === "err")
      return err({
        _tag: "InsightProviderCatalogUnavailable",
        reason: mapCodexFailure(result.error),
      });
    return ok({
      providers: [
        {
          id: "codex-cli-account",
          label: "Codex CLI account",
          available: true,
          guidance: "Use the existing local Codex CLI login.",
        },
      ],
      models: result.value.map((model) => codexModel(model)),
    });
  }

  /** Revalidates the exact provider/model/reasoning choice immediately before a run. */
  async validate(
    selection: InsightSelection,
  ): Promise<Result<void, "model_unavailable" | "catalog_unavailable">> {
    if (selection.provider === "pi") {
      if (selection.reasoning === "minimal" || selection.reasoning === "xhigh")
        return err("model_unavailable");
      const result = await this.pi.get();
      if (result._tag === "err") return err("catalog_unavailable");
      const model = canonicalModelId(selection.model);
      return model !== undefined &&
        result.value.models.some((candidate) => candidate.id === model)
        ? ok(undefined)
        : err("model_unavailable");
    }
    const activated = await this.activateCodex();
    if (activated._tag === "err") return err("catalog_unavailable");
    return activated.value.models.some(
      (model) =>
        model.provider === selection.provider &&
        model.id === selection.model &&
        model.reasoning.includes(selection.reasoning),
    )
      ? ok(undefined)
      : err("model_unavailable");
  }
}

function codexModel(model: CodexModel): InsightProviderModel {
  if (model.defaultReasoning === undefined) {
    return {
      provider: "codex-cli-account",
      id: model.id,
      label: model.label,
      reasoning: model.reasoning,
    };
  }
  return {
    provider: "codex-cli-account",
    id: model.id,
    label: model.label,
    reasoning: model.reasoning,
    defaultReasoning: model.defaultReasoning,
  };
}

function mapCodexFailure(
  failure: CodexAppServerFailure,
): InsightProviderCatalogFailure["reason"] {
  switch (failure.reason) {
    case "authentication_required":
      return "authentication_required";
    case "rate_limited":
      return "rate_limited";
    case "timed_out":
      return "timed_out";
    case "invalid_result":
      return "invalid_result";
    default:
      return "runtime_unavailable";
  }
}
