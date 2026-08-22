import { createOpenAI } from "@ai-sdk/openai";
import { generateText } from "ai";
import type {
  Judge,
  JudgeConfig,
  JudgeInput,
  JudgeResult,
} from "../types/judge";
import type { ProviderPrompts } from "../types/prompts";
import { buildJudgePrompt, getJudgePrompt, parseJudgeResponse } from "./base";
import { logger } from "../utils/logger";

export class LocalJudge implements Judge {
  name = "local";

  async initialize(config: JudgeConfig): Promise<void> {
    logger.info("Initialized Local judge (qwen2.5:3b via Ollama)");
  }

  async evaluate(input: JudgeInput): Promise<JudgeResult> {
    const prompt = buildJudgePrompt(input);
    const client = createOpenAI({
      apiKey: "ollama",
      baseURL: process.env.OPENAI_BASE_URL || "http://localhost:11434/v1",
    });

    try {
      const { text } = await generateText(
        {
          model: client("qwen2.5:3b"),
          prompt,
          maxTokens: 500,
        } as Parameters<typeof generateText>[0],
      );
      return parseJudgeResponse(text);
    } catch (err) {
      const hyp = String(input.hypothesis).toLowerCase().trim();
      const gt = String(input.groundTruth).toLowerCase().trim();
      const matches = hyp.includes(gt) || gt.includes(hyp);
      return {
        score: matches ? 1 : 0,
        label: matches ? "correct" : "incorrect",
        explanation:
          `Fallback evaluation: '${input.hypothesis}' vs '${input.groundTruth}'`,
      };
    }
  }

  getPromptForQuestionType(
    questionType: string,
    providerPrompts?: ProviderPrompts,
  ): string {
    return getJudgePrompt(questionType, providerPrompts);
  }

  getModel() {
    const client = createOpenAI({
      apiKey: "ollama",
      baseURL: process.env.OPENAI_BASE_URL || "http://localhost:11434/v1",
    });
    return client("qwen2.5:3b");
  }
}

export default LocalJudge;
