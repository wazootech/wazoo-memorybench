import { createGoogleGenerativeAI } from "@ai-sdk/google"
import { generateText } from "ai"
import type { Judge, JudgeConfig, JudgeInput, JudgeResult } from "../types/judge"
import type { ProviderPrompts } from "../types/prompts"
import { buildJudgePrompt, getJudgePrompt, parseJudgeResponse } from "./base"
import { logger } from "../utils/logger"
import { DEFAULT_JUDGE_MODELS, getModelConfig, ModelConfig } from "../utils/models"

export class GoogleJudge implements Judge {
  name = "google"
  private modelConfig: ModelConfig | null = null
  private client: ReturnType<typeof createGoogleGenerativeAI> | null = null

  async initialize(config: JudgeConfig): Promise<void> {
    this.client = createGoogleGenerativeAI({
      apiKey: config.apiKey,
    })
    const modelAlias = config.model || DEFAULT_JUDGE_MODELS.google
    this.modelConfig = getModelConfig(modelAlias)
    logger.info(
      `Initialized Google judge with model: ${this.modelConfig.displayName} (${this.modelConfig.id})`
    )
  }

  async evaluate(input: JudgeInput): Promise<JudgeResult> {
    if (!this.client || !this.modelConfig) {
      throw new Error("Judge not initialized")
    }

    const prompt = buildJudgePrompt(input)

    const baseParams: Record<string, unknown> = {
      model: this.client(this.modelConfig.id),
      prompt,
      maxTokens: this.modelConfig.defaultMaxTokens,
    }

    if (this.modelConfig.supportsTemperature) {
      baseParams.temperature = this.modelConfig.defaultTemperature
    }

    const passes = 3
    const results: JudgeResult[] = []
    for (let i = 0; i < passes; i++) {
      const { text } = await generateText({
        ...(baseParams as Parameters<typeof generateText>[0]),
      } as Parameters<typeof generateText>[0])
      results.push(parseJudgeResponse(text))
    }

    const correctVotes = results.filter((r) => r.score === 1).length
    const score = correctVotes >= 2 ? 1 : 0
    const label = score === 1 ? "correct" : "incorrect"
    const explanation =
      `[majority ${correctVotes}/${passes}] ` +
      (score === 1
        ? (results.find((r) => r.score === 1)?.explanation ?? results[0].explanation)
        : results.map((r) => r.explanation).join(" | "))

    return { score, label, explanation }
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

export default GoogleJudge
