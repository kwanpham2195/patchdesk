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

/** One provider's status paired with the models that listing produced. */
type ProviderSurvey = {
  readonly status: InsightProviderStatus;
  readonly models: ReadonlyArray<InsightProviderModel>;
};

/**
 * The single listing seam a provider is reached through. Every provider
 * registers exactly one, so adding a provider is a registry entry rather than
 * another branch inside the catalog's methods.
 */
type ProviderModelSource = {
  /** Status and the models this provider lists without starting a runtime. */
  survey(): Promise<ProviderSurvey>;
  /** Status and live models, starting the provider's runtime when it has one. */
  activate(): Promise<Result<ProviderSurvey, InsightProviderCatalogFailure>>;
};

/** The catalog only ever lists models, so it asks for only that one method. */
type CodexClientFactory = (
  executablePath: string,
) => Pick<CodexAppServerClient, "listModels">;

/** Coordinates passive status, explicit Codex discovery, and exact run validation. */
export class InsightProviderCatalog {
  /**
   * Insertion order is the order the catalog publishes providers in, and the
   * record type is what forces every provider to have a source at all.
   */
  private readonly sources: Readonly<
    Record<InsightProvider, ProviderModelSource>
  >;

  constructor(
    pi: PiRuntimeModelCatalog,
    clientFactory: CodexClientFactory,
    executableResolver: (name: string) => Promise<string | undefined> = (
      name,
    ) => discoverPathOnlyExecutable(name),
  ) {
    this.sources = {
      pi: piModelSource(pi),
      "codex-cli-account": codexModelSource(clientFactory, executableResolver),
    };
  }

  /** Returns provider statuses and the models no provider runtime is needed for. */
  async passive(): Promise<
    Result<InsightProviderCatalogSnapshot, InsightProviderCatalogFailure>
  > {
    const surveys = await Promise.all(
      Object.values(this.sources).map((source) => source.survey()),
    );
    return ok({
      providers: surveys.map((survey) => survey.status),
      models: surveys.flatMap((survey) => survey.models),
    });
  }

  /** Explicitly starts a throwaway Codex app server and loads its live models. */
  async activateCodex(): Promise<
    Result<InsightProviderCatalogSnapshot, InsightProviderCatalogFailure>
  > {
    const activated = await this.sources["codex-cli-account"].activate();
    if (activated._tag === "err") return activated;
    return ok({
      providers: [activated.value.status],
      models: activated.value.models,
    });
  }

  /** Revalidates the exact provider/model/reasoning choice immediately before a run. */
  async validate(
    selection: InsightSelection,
  ): Promise<Result<void, "model_unavailable" | "catalog_unavailable">> {
    const activated = await this.sources[selection.provider].activate();
    if (activated._tag === "err") return err("catalog_unavailable");
    return activated.value.models.some(
      (model) =>
        model.id === selection.model &&
        model.reasoning.includes(selection.reasoning),
    )
      ? ok(undefined)
      : err("model_unavailable");
  }
}

const PI_GUIDANCE =
  "Export a provider key such as ANTHROPIC_API_KEY in your shell profile, then relaunch Patchdesk.";

/** Pi lists from the local runtime catalog, so listing never starts anything. */
function piModelSource(pi: PiRuntimeModelCatalog): ProviderModelSource {
  const survey = async (): Promise<ProviderSurvey> => {
    const result = await pi.get();
    return {
      status: {
        id: "pi",
        label: "API key",
        available: result._tag === "ok",
        guidance: PI_GUIDANCE,
      },
      models:
        result._tag === "ok"
          ? result.value.models.map((model) => ({
              provider: "pi" as const,
              id: model.id,
              label: model.label,
              reasoning: ["low", "medium", "high"] as const,
              defaultReasoning: "medium" as const,
            }))
          : [],
    };
  };
  return {
    survey,
    // Pi has no runtime to activate: the passive listing is already the live one.
    async activate() {
      const surveyed = await survey();
      return surveyed.status.available
        ? ok(surveyed)
        : err({
            _tag: "InsightProviderCatalogUnavailable",
            reason: "runtime_unavailable",
          });
    },
  };
}

/** Codex lists only from a started app server, so surveying stops at PATH discovery. */
function codexModelSource(
  clientFactory: CodexClientFactory,
  executableResolver: (name: string) => Promise<string | undefined>,
): ProviderModelSource {
  const status = (available: boolean): InsightProviderStatus => ({
    id: "codex-cli-account",
    label: "Codex CLI account",
    available,
    guidance: available
      ? "Use the existing local Codex CLI login."
      : "Install Codex and expose codex on the app launch PATH, then log in externally.",
  });
  return {
    async survey() {
      const executablePath = await executableResolver("codex");
      return { status: status(executablePath !== undefined), models: [] };
    },
    async activate() {
      const executablePath = await executableResolver("codex");
      if (executablePath === undefined)
        return err({
          _tag: "InsightProviderCatalogUnavailable",
          reason: "runtime_unavailable",
        });
      const result = await clientFactory(executablePath).listModels();
      if (result._tag === "err")
        return err({
          _tag: "InsightProviderCatalogUnavailable",
          reason: mapCodexFailure(result.error),
        });
      return ok({
        status: status(true),
        models: result.value.map((model) => codexModel(model)),
      });
    },
  };
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
