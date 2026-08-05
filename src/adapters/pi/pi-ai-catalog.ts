import { AMAZON_BEDROCK_MODELS } from "@earendil-works/pi-ai/providers/amazon-bedrock.models";
import { ANT_LING_MODELS } from "@earendil-works/pi-ai/providers/ant-ling.models";
import { ANTHROPIC_MODELS } from "@earendil-works/pi-ai/providers/anthropic.models";
import { AZURE_OPENAI_RESPONSES_MODELS } from "@earendil-works/pi-ai/providers/azure-openai-responses.models";
import { CEREBRAS_MODELS } from "@earendil-works/pi-ai/providers/cerebras.models";
import { CLOUDFLARE_AI_GATEWAY_MODELS } from "@earendil-works/pi-ai/providers/cloudflare-ai-gateway.models";
import { DEEPSEEK_MODELS } from "@earendil-works/pi-ai/providers/deepseek.models";
import { FIREWORKS_MODELS } from "@earendil-works/pi-ai/providers/fireworks.models";
import { GOOGLE_MODELS } from "@earendil-works/pi-ai/providers/google.models";
import { GOOGLE_VERTEX_MODELS } from "@earendil-works/pi-ai/providers/google-vertex.models";
import { GROQ_MODELS } from "@earendil-works/pi-ai/providers/groq.models";
import { HUGGINGFACE_MODELS } from "@earendil-works/pi-ai/providers/huggingface.models";
import { KIMI_CODING_MODELS } from "@earendil-works/pi-ai/providers/kimi-coding.models";
import { MINIMAX_CN_MODELS } from "@earendil-works/pi-ai/providers/minimax-cn.models";
import { MINIMAX_MODELS } from "@earendil-works/pi-ai/providers/minimax.models";
import { MISTRAL_MODELS } from "@earendil-works/pi-ai/providers/mistral.models";
import { MOONSHOTAI_CN_MODELS } from "@earendil-works/pi-ai/providers/moonshotai-cn.models";
import { MOONSHOTAI_MODELS } from "@earendil-works/pi-ai/providers/moonshotai.models";
import { NVIDIA_MODELS } from "@earendil-works/pi-ai/providers/nvidia.models";
import { OPENAI_MODELS } from "@earendil-works/pi-ai/providers/openai.models";
import { OPENCODE_GO_MODELS } from "@earendil-works/pi-ai/providers/opencode-go.models";
import { OPENCODE_MODELS } from "@earendil-works/pi-ai/providers/opencode.models";
import { OPENROUTER_MODELS } from "@earendil-works/pi-ai/providers/openrouter.models";
import { TOGETHER_MODELS } from "@earendil-works/pi-ai/providers/together.models";
import { VERCEL_AI_GATEWAY_MODELS } from "@earendil-works/pi-ai/providers/vercel-ai-gateway.models";
import { XAI_MODELS } from "@earendil-works/pi-ai/providers/xai.models";
import { XIAOMI_TOKEN_PLAN_AMS_MODELS } from "@earendil-works/pi-ai/providers/xiaomi-token-plan-ams.models";
import { XIAOMI_TOKEN_PLAN_CN_MODELS } from "@earendil-works/pi-ai/providers/xiaomi-token-plan-cn.models";
import { XIAOMI_TOKEN_PLAN_SGP_MODELS } from "@earendil-works/pi-ai/providers/xiaomi-token-plan-sgp.models";
import { XIAOMI_MODELS } from "@earendil-works/pi-ai/providers/xiaomi.models";
import { ZAI_CODING_CN_MODELS } from "@earendil-works/pi-ai/providers/zai-coding-cn.models";
import { ZAI_MODELS } from "@earendil-works/pi-ai/providers/zai.models";

type PiAiModel = { readonly id: string; readonly name: string; readonly provider: string };

/** Static, typed model metadata from the pinned pi-ai catalog, limited to Patchdesk's allowlist. */
function catalog(provider: string, models: Readonly<Record<string, PiAiModel>>): { readonly provider: string; readonly models: ReadonlyArray<PiAiModel> } {
  return { provider, models: Object.values(models) };
}

export const PI_AI_CATALOG: ReadonlyArray<{ readonly provider: string; readonly models: ReadonlyArray<PiAiModel> }> = [
  catalog("amazon-bedrock", AMAZON_BEDROCK_MODELS),
  catalog("ant-ling", ANT_LING_MODELS),
  catalog("anthropic", ANTHROPIC_MODELS),
  catalog("azure-openai-responses", AZURE_OPENAI_RESPONSES_MODELS),
  catalog("cerebras", CEREBRAS_MODELS),
  catalog("cloudflare-ai-gateway", CLOUDFLARE_AI_GATEWAY_MODELS),
  catalog("deepseek", DEEPSEEK_MODELS),
  catalog("fireworks", FIREWORKS_MODELS),
  catalog("google", GOOGLE_MODELS),
  catalog("google-vertex", GOOGLE_VERTEX_MODELS),
  catalog("groq", GROQ_MODELS),
  catalog("huggingface", HUGGINGFACE_MODELS),
  catalog("kimi-coding", KIMI_CODING_MODELS),
  catalog("minimax", MINIMAX_MODELS),
  catalog("minimax-cn", MINIMAX_CN_MODELS),
  catalog("mistral", MISTRAL_MODELS),
  catalog("moonshotai", MOONSHOTAI_MODELS),
  catalog("moonshotai-cn", MOONSHOTAI_CN_MODELS),
  catalog("nvidia", NVIDIA_MODELS),
  catalog("openai", OPENAI_MODELS),
  catalog("opencode", OPENCODE_MODELS),
  catalog("opencode-go", OPENCODE_GO_MODELS),
  catalog("openrouter", OPENROUTER_MODELS),
  catalog("together", TOGETHER_MODELS),
  catalog("vercel-ai-gateway", VERCEL_AI_GATEWAY_MODELS),
  catalog("xai", XAI_MODELS),
  catalog("xiaomi", XIAOMI_MODELS),
  catalog("xiaomi-token-plan-ams", XIAOMI_TOKEN_PLAN_AMS_MODELS),
  catalog("xiaomi-token-plan-cn", XIAOMI_TOKEN_PLAN_CN_MODELS),
  catalog("xiaomi-token-plan-sgp", XIAOMI_TOKEN_PLAN_SGP_MODELS),
  catalog("zai", ZAI_MODELS),
  catalog("zai-coding-cn", ZAI_CODING_CN_MODELS),
];
