import type { Judge, JudgeConfig, JudgeInput, JudgeResult } from "../types/judge"
import type { ProviderPrompts } from "../types/prompts"
import { buildJudgePrompt, getJudgePrompt, parseJudgeResponse } from "./base"
import { DeepSeekClient } from "../utils/deepseek-client"
import { logger } from "../utils/logger"
import { DEFAULT_JUDGE_MODELS, getModelConfig, ModelConfig } from "../utils/models"

/**
 * DeepSeekJudge talks to DeepSeek's OpenAI-compatible API (DEEPSEEK_BASE_URL)
 * through the dedicated raw-fetch DeepSeekClient — NOT the AI SDK. The SDK's
 * OpenAI provider strips DeepSeek-specific top-level body params (thinking),
 * so the judge uses the client to send `thinking: {type:"disabled"}` and
 * JSON output mode, which the shared JSON-scoring prompt parsing expects.
 * A missing DEEPSEEK_API_KEY fails fast in the client rather than silently
 * borrowing OPENAI_API_KEY.
 */
export class DeepSeekJudge implements Judge {
  name = "deepseek"
  private modelConfig: ModelConfig | null = null
  private client: DeepSeekClient | null = null

  async initialize(config: JudgeConfig): Promise<void> {
    this.client = new DeepSeekClient({
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
    })
    const modelAlias = config.model || DEFAULT_JUDGE_MODELS.deepseek
    this.modelConfig = getModelConfig(modelAlias)
    logger.info(
      `Initialized DeepSeek judge with model: ${this.modelConfig.displayName} (${this.modelConfig.id})`
    )
  }

  async evaluate(input: JudgeInput): Promise<JudgeResult> {
    if (!this.client || !this.modelConfig) {
      throw new Error("Judge not initialized")
    }

    const prompt = buildJudgePrompt(input)

    // deepseek-v4-flash is a reasoning model; disable thinking for judging so
    // the JSON score response is fast and the output budget is not consumed by
    // reasoning tokens. This is sent top-level by the DeepSeek client — the
    // ai-sdk route strips it.
    const { text } = await this.client.chatCompletion({
      model: this.modelConfig.id,
      prompt,
      maxTokens: this.modelConfig.defaultMaxTokens,
      temperature: this.modelConfig.supportsTemperature
        ? this.modelConfig.defaultTemperature
        : undefined,
      responseFormat: "json_object",
      thinking: "disabled",
    })

    return parseJudgeResponse(text)
  }

  getPromptForQuestionType(questionType: string, providerPrompts?: ProviderPrompts): string {
    return getJudgePrompt(questionType, providerPrompts)
  }

  getModel() {
    // DeepSeek calls go through the raw-fetch client, not the AI SDK, so there
    // is no LanguageModel instance to hand retrieval-metrics evaluation. The
    // orchestrator skips retrieval metrics when the judge's model is null.
    return null
  }
}

export default DeepSeekJudge
