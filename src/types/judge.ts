import type { ProviderPrompts } from "./prompts"

export interface JudgeConfig {
  apiKey: string
  model?: string
  /** Optional OpenAI-compatible base URL override (e.g. DeepSeek). */
  baseUrl?: string
}

export interface JudgeInput {
  question: string
  /** Raw question type from benchmark (e.g., "1", "single-session-user", "user_evidence") */
  questionType: string
  groundTruth: string
  hypothesis: string
  context?: string
  /** Optional provider-specific judge prompts */
  providerPrompts?: ProviderPrompts
}

export interface JudgeResult {
  score: number
  label: "correct" | "incorrect"
  explanation: string
}

export interface Judge {
  name: string
  initialize(config: JudgeConfig): Promise<void>
  evaluate(input: JudgeInput): Promise<JudgeResult>
  getPromptForQuestionType(questionType: string, providerPrompts?: ProviderPrompts): string
  /**
   * The judge's AI SDK LanguageModel, or null when the judge talks to its
   * provider through a non-SDK client (e.g. DeepSeek's raw-fetch client).
   * Callers that need a LanguageModel (retrieval-metrics evaluation) must
   * skip when this is null.
   */
  getModel(): import("ai").LanguageModel | null
}

export type JudgeName = "openai" | "anthropic" | "google" | "deepseek" | "local"
