import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { err, ok, type Result } from "../../domain/result";

/** A bounded, renderer-safe availability description. It never contains values or paths. */
export type PiProviderStatus = {
  readonly id: string;
  readonly label: string;
  readonly configured: boolean;
  readonly source?: string;
  readonly guidance: string;
};

export type PiProviderCatalog = {
  readonly providers: ReadonlyArray<PiProviderStatus>;
  readonly configured: boolean;
};

export type PiProviderCatalogFailure = { readonly _tag: "PiProviderCatalogUnavailable" };

export type PiProviderCatalogOptions = {
  readonly environment?: (name: string) => string | undefined;
  readonly fileExists?: (path: string) => Promise<boolean>;
  readonly homeDirectory?: string;
};

type ProviderDefinition = {
  readonly id: string;
  readonly label: string;
  readonly keys?: ReadonlyArray<string>;
  readonly requiredKeys?: ReadonlyArray<string>;
  readonly ambient?: "bedrock" | "vertex";
  readonly guidance: string;
};

// Keep this list explicit. In particular, OAuth-only and Worker-binding providers must not
// become selectable merely because Pi adds them to a settings file.
const PROVIDERS: ReadonlyArray<ProviderDefinition> = [
  provider("amazon-bedrock", "Amazon Bedrock", "bedrock"),
  provider("ant-ling", "Ant Ling", "ANT_LING_API_KEY"),
  provider("anthropic", "Anthropic", "ANTHROPIC_API_KEY"),
  provider("azure-openai-responses", "Azure OpenAI", "AZURE_OPENAI_API_KEY"),
  provider("cerebras", "Cerebras", "CEREBRAS_API_KEY"),
  provider("cloudflare-ai-gateway", "Cloudflare AI Gateway", "CLOUDFLARE_API_KEY", [
    "CLOUDFLARE_API_KEY",
    "CLOUDFLARE_ACCOUNT_ID",
    "CLOUDFLARE_GATEWAY_ID",
  ]),
  provider("deepseek", "DeepSeek", "DEEPSEEK_API_KEY"),
  provider("fireworks", "Fireworks", "FIREWORKS_API_KEY"),
  provider("google", "Google", "GEMINI_API_KEY"),
  provider("google-vertex", "Google Vertex", "vertex", undefined, "GOOGLE_CLOUD_API_KEY"),
  provider("groq", "Groq", "GROQ_API_KEY"),
  provider("huggingface", "Hugging Face", "HF_TOKEN"),
  provider("kimi-coding", "Kimi Coding", "KIMI_API_KEY"),
  provider("minimax", "MiniMax", "MINIMAX_API_KEY"),
  provider("minimax-cn", "MiniMax China", "MINIMAX_CN_API_KEY"),
  provider("mistral", "Mistral", "MISTRAL_API_KEY"),
  provider("moonshotai", "Moonshot", "MOONSHOT_API_KEY"),
  provider("moonshotai-cn", "Moonshot China", "MOONSHOT_API_KEY"),
  provider("nvidia", "NVIDIA", "NVIDIA_API_KEY"),
  provider("openai", "OpenAI", "OPENAI_API_KEY"),
  provider("opencode", "OpenCode", "OPENCODE_API_KEY"),
  provider("opencode-go", "OpenCode Go", "OPENCODE_API_KEY"),
  provider("openrouter", "OpenRouter", "OPENROUTER_API_KEY"),
  provider("together", "Together", "TOGETHER_API_KEY"),
  provider("vercel-ai-gateway", "Vercel AI Gateway", "AI_GATEWAY_API_KEY"),
  provider("xai", "xAI", "XAI_API_KEY"),
  provider("xiaomi", "Xiaomi", "XIAOMI_API_KEY"),
  provider("xiaomi-token-plan-ams", "Xiaomi Token Plan (AMS)", "XIAOMI_TOKEN_PLAN_AMS_API_KEY"),
  provider("xiaomi-token-plan-cn", "Xiaomi Token Plan (China)", "XIAOMI_TOKEN_PLAN_CN_API_KEY"),
  provider("xiaomi-token-plan-sgp", "Xiaomi Token Plan (Singapore)", "XIAOMI_TOKEN_PLAN_SGP_API_KEY"),
  provider("zai", "ZAI", "ZAI_API_KEY"),
  provider("zai-coding-cn", "ZAI Coding China", "ZAI_CODING_CN_API_KEY"),
];

function provider(
  id: string,
  label: string,
  source: string,
  requiredKeys?: ReadonlyArray<string>,
  ambientApiKey?: string,
): ProviderDefinition {
  if (source === "bedrock" || source === "vertex") {
    return {
      id,
      label,
      ...(ambientApiKey === undefined ? {} : { keys: [ambientApiKey] }),
      ambient: source,
      guidance: source === "vertex" ? "Set a Vertex API key or configure Google ADC with a project and location." : "Configure AWS credentials or a named AWS profile in the Electron process.",
    };
  }
  return {
    id,
    label,
    keys: [source],
    ...(requiredKeys === undefined ? {} : { requiredKeys }),
    guidance: "Set the provider API key in the Electron process environment.",
  };
}

const PROVIDER_BY_ID = new Map(PROVIDERS.map((provider) => [provider.id, provider]));

export class LocalPiProviderCatalog {
  private readonly environment: (name: string) => string | undefined;
  private readonly fileExists: (path: string) => Promise<boolean>;
  private readonly homeDirectory: string;

  constructor(options: PiProviderCatalogOptions = {}) {
    this.environment = options.environment ?? ((name) => process.env[name]);
    this.fileExists = options.fileExists ?? (async (path) => access(path).then(() => true).catch(() => false));
    this.homeDirectory = options.homeDirectory ?? homedir();
  }

  async get(): Promise<Result<PiProviderCatalog, PiProviderCatalogFailure>> {
    const statuses = await Promise.all(PROVIDERS.map(async (provider) => this.status(provider)));
    return ok({ providers: statuses, configured: statuses.some((provider) => provider.configured) });
  }

  private async status(provider: ProviderDefinition): Promise<PiProviderStatus> {
    if (provider.ambient === "bedrock") {
      const source = await this.bedrockSource();
      return { id: provider.id, label: provider.label, configured: source !== undefined, ...(source === undefined ? {} : { source }), guidance: provider.guidance };
    }
    if (provider.ambient === "vertex") {
      const source = await this.vertexSource(provider);
      return { id: provider.id, label: provider.label, configured: source !== undefined, ...(source === undefined ? {} : { source }), guidance: provider.guidance };
    }
    const key = provider.keys?.find((name) => hasValue(this.environment(name)));
    const configured = provider.requiredKeys === undefined
      ? key !== undefined
      : provider.requiredKeys.every((name) => hasValue(this.environment(name)));
    return {
      id: provider.id,
      label: provider.label,
      configured,
      ...(configured && key !== undefined ? { source: key } : {}),
      guidance: provider.guidance,
    };
  }

  private async bedrockSource(): Promise<string | undefined> {
    if (hasValue(this.environment("AWS_PROFILE"))) return "AWS profile";
    if (hasValue(this.environment("AWS_ACCESS_KEY_ID")) && hasValue(this.environment("AWS_SECRET_ACCESS_KEY"))) return "AWS credentials";
    if (hasValue(this.environment("AWS_BEARER_TOKEN_BEDROCK"))) return "AWS Bedrock bearer token";
    if (hasValue(this.environment("AWS_CONTAINER_CREDENTIALS_RELATIVE_URI")) || hasValue(this.environment("AWS_CONTAINER_CREDENTIALS_FULL_URI"))) return "AWS container credentials";
    if (hasValue(this.environment("AWS_WEB_IDENTITY_TOKEN_FILE"))) return "AWS web identity";
    if (await this.fileExists(join(this.homeDirectory, ".aws", "credentials")) || await this.fileExists(join(this.homeDirectory, ".aws", "config"))) return "AWS profile";
    return undefined;
  }

  private async vertexSource(provider: ProviderDefinition): Promise<string | undefined> {
    const apiKey = provider.keys?.find((name) => hasValue(this.environment(name)));
    if (apiKey !== undefined) return apiKey;
    const project = hasValue(this.environment("GOOGLE_CLOUD_PROJECT")) || hasValue(this.environment("GCLOUD_PROJECT"));
    const location = hasValue(this.environment("GOOGLE_CLOUD_LOCATION"));
    if (!project || !location) return undefined;
    const explicit = this.environment("GOOGLE_APPLICATION_CREDENTIALS");
    const credentials = explicit === undefined
      ? join(this.homeDirectory, ".config", "gcloud", "application_default_credentials.json")
      : explicit;
    return await this.fileExists(credentials) ? "Google ADC" : undefined;
  }
}

export function providerCatalog(): ReadonlyArray<ProviderDefinition> { return PROVIDERS; }
export function providerDefinition(id: string): ProviderDefinition | undefined { return PROVIDER_BY_ID.get(id); }

function hasValue(value: string | undefined): value is string {
  return value !== undefined && value.trim().length > 0;
}

export function unavailableProviderCatalog(): Result<never, PiProviderCatalogFailure> {
  return err({ _tag: "PiProviderCatalogUnavailable" });
}
