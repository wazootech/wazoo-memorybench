import { createOpenAI } from "@ai-sdk/openai"
import { generateText } from "ai"
import type { Judge, JudgeConfig, JudgeInput, JudgeResult } from "../types/judge"
import type { ProviderPrompts } from "../types/prompts"
import { buildJudgePrompt, getJudgePrompt, parseJudgeResponse } from "./base"
import { logger } from "../utils/logger"
import { DEFAULT_JUDGE_MODELS, getModelConfig, ModelConfig } from "../utils/models"

export class OpenAIJudge implements Judge {
  name = "openai"
  private modelConfig: ModelConfig | null = null
  private client: ReturnType<typeof createOpenAI> | null = null

  async initialize(config: JudgeConfig): Promise<void> {
    this.client = createOpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseUrl,
    })
    const modelAlias = config.model || DEFAULT_JUDGE_MODELS.openai
    this.modelConfig = getModelConfig(modelAlias)
    logger.info(
      `Initialized OpenAI judge with model: ${this.modelConfig.displayName} (${this.modelConfig.id})`
    )
  }

  /** Subclasses (e.g. DeepSeek) can add providerOptions like thinking toggles. */
  protected getProviderOptions(): Record<string, unknown> {
    return {}
  }

  async evaluate(input: JudgeInput): Promise<JudgeResult> {
    if (!this.client || !this.modelConfig) {
      throw new Error("Judge not initialized")
    }

    const prompt = buildJudgePrompt(input)

    const params: Record<string, unknown> = {
      model: this.client(this.modelConfig.id),
      prompt,
    }

    if (this.modelConfig.supportsTemperature) {
      params.temperature = this.modelConfig.defaultTemperature
    }

    params.maxTokens = this.modelConfig.defaultMaxTokens

    const providerOptions = this.getProviderOptions()
    if (Object.keys(providerOptions).length > 0) {
      params.providerOptions = providerOptions
    }

    const { text } = await generateText(params as Parameters<typeof generateText>[0])

    return parseJudgeResponse(text)
  }

  getPromptForQuestionType(questionType: string, providerPrompts?: ProviderPrompts): string {
    return getJudgePrompt(questionType, providerPrompts)
  }

  getModel() {
    if (!this.client || !this.modelConfig) {
      throw new Error("Judge not initialized")
    }
    return this.client(this.modelConfig.id)
  }
}

export default OpenAIJudge
