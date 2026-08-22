export interface Config {
  supermemoryApiKey: string
  supermemoryBaseUrl: string
  mem0ApiKey: string
  zepApiKey: string
  openaiApiKey: string
  anthropicApiKey: string
  googleApiKey: string
  deepseekApiKey: string
  deepseekBaseUrl: string
}

export const config: Config = {
  supermemoryApiKey: process.env.SUPERMEMORY_API_KEY || "",
  supermemoryBaseUrl: process.env.SUPERMEMORY_BASE_URL || "https://api.supermemory.ai",
  mem0ApiKey: process.env.MEM0_API_KEY || "",
  zepApiKey: process.env.ZEP_API_KEY || "",
  openaiApiKey: process.env.OPENAI_API_KEY || "",
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || "",
  googleApiKey: process.env.GOOGLE_API_KEY || process.env.GOOGLE_GENERATIVE_AI_API_KEY || "",
  deepseekApiKey: process.env.DEEPSEEK_API_KEY || "",
  deepseekBaseUrl: process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com",
}

export function getProviderConfig(provider: string): { apiKey: string; baseUrl?: string } {
  switch (provider) {
    case "supermemory":
      return {
        apiKey: config.supermemoryApiKey,
        baseUrl: config.supermemoryBaseUrl,
      }
    case "mem0":
      return { apiKey: config.mem0ApiKey }
    case "zep":
      return { apiKey: config.zepApiKey }
    case "filesystem":
      return { apiKey: config.openaiApiKey } // Filesystem uses OpenAI for memory extraction
    case "rag":
      return { apiKey: config.openaiApiKey } // RAG provider uses OpenAI for embeddings
    case "worlds":
      return { apiKey: config.googleApiKey }
    default:
      throw new Error(`Unknown provider: ${provider}`)
  }
}

export function getJudgeConfig(judge: string): {
  apiKey: string
  model?: string
  baseUrl?: string
} {
  switch (judge) {
    case "openai":
      return { apiKey: config.openaiApiKey }
    case "anthropic":
      return { apiKey: config.anthropicApiKey }
    case "google":
      return { apiKey: config.googleApiKey }
    case "deepseek":
      return { apiKey: config.deepseekApiKey, baseUrl: config.deepseekBaseUrl }
    case "local":
      return { apiKey: "local" }
    default:
      throw new Error(`Unknown judge: ${judge}`)
  }
}
