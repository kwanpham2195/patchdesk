import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

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

const PI_VERSION = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")).dependencies["@earendil-works/pi-ai"];
const CATALOGS = [
  ["amazon-bedrock", AMAZON_BEDROCK_MODELS], ["ant-ling", ANT_LING_MODELS], ["anthropic", ANTHROPIC_MODELS],
  ["azure-openai-responses", AZURE_OPENAI_RESPONSES_MODELS], ["cerebras", CEREBRAS_MODELS], ["cloudflare-ai-gateway", CLOUDFLARE_AI_GATEWAY_MODELS],
  ["deepseek", DEEPSEEK_MODELS], ["fireworks", FIREWORKS_MODELS], ["google", GOOGLE_MODELS], ["google-vertex", GOOGLE_VERTEX_MODELS],
  ["groq", GROQ_MODELS], ["huggingface", HUGGINGFACE_MODELS], ["kimi-coding", KIMI_CODING_MODELS], ["minimax", MINIMAX_MODELS],
  ["minimax-cn", MINIMAX_CN_MODELS], ["mistral", MISTRAL_MODELS], ["moonshotai", MOONSHOTAI_MODELS], ["moonshotai-cn", MOONSHOTAI_CN_MODELS],
  ["nvidia", NVIDIA_MODELS], ["openai", OPENAI_MODELS], ["opencode", OPENCODE_MODELS], ["opencode-go", OPENCODE_GO_MODELS],
  ["openrouter", OPENROUTER_MODELS], ["together", TOGETHER_MODELS], ["vercel-ai-gateway", VERCEL_AI_GATEWAY_MODELS], ["xai", XAI_MODELS],
  ["xiaomi", XIAOMI_MODELS], ["xiaomi-token-plan-ams", XIAOMI_TOKEN_PLAN_AMS_MODELS], ["xiaomi-token-plan-cn", XIAOMI_TOKEN_PLAN_CN_MODELS],
  ["xiaomi-token-plan-sgp", XIAOMI_TOKEN_PLAN_SGP_MODELS], ["zai", ZAI_MODELS], ["zai-coding-cn", ZAI_CODING_CN_MODELS],
];

export function generateModelCatalog() {
  const catalog = CATALOGS.map(([provider, models]) => ({
    provider,
    models: Object.values(models).map((model) => projectModel(provider, model)).sort((left, right) => left.id.localeCompare(right.id)),
  })).sort((left, right) => left.provider.localeCompare(right.provider));
  const payload = { piVersion: PI_VERSION, catalog };
  return { ...payload, digest: createHash("sha256").update(JSON.stringify(payload)).digest("hex") };
}

function projectModel(provider, value) {
  if (typeof value !== "object" || value === null) throw new Error(`Invalid ${provider} model catalog value`);
  const { id, name, provider: valueProvider } = value;
  if (typeof id !== "string" || !id || typeof name !== "string" || !name || valueProvider !== provider) {
    throw new Error(`Invalid ${provider} model catalog value`);
  }
  return { id, name, provider };
}

export async function writeModelCatalog(output = new URL("../../../src/adapters/pi/pi-ai-catalog.generated.ts", import.meta.url)) {
  const artifact = generateModelCatalog();
  await writeFile(output, `// Generated by runtime/flue/scripts/generate-model-catalog.mjs. Do not edit.\nexport const generatedPiAiCatalog: unknown = ${JSON.stringify(artifact, null, 2)};\n`);
  return artifact;
}

if (import.meta.url === `file://${process.argv[1]}`) await writeModelCatalog();
