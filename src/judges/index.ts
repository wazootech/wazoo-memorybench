import type { Judge, JudgeName } from "../types/judge";
import { OpenAIJudge } from "./openai";
import { AnthropicJudge } from "./anthropic";
import { GoogleJudge } from "./google";
import { DeepSeekJudge } from "./deepseek";
import { LocalJudge } from "./local";

const judges: Record<JudgeName, new () => Judge> = {
  openai: OpenAIJudge,
  anthropic: AnthropicJudge,
  google: GoogleJudge,
  deepseek: DeepSeekJudge,
  local: LocalJudge,
};

export function createJudge(name: JudgeName): Judge {
  const JudgeClass = judges[name];
  if (!JudgeClass) {
    throw new Error(
      `Unknown judge: ${name}. Available: ${Object.keys(judges).join(", ")}`,
    );
  }
  return new JudgeClass();
}

export function getAvailableJudges(): JudgeName[] {
  return Object.keys(judges) as JudgeName[];
}

export { AnthropicJudge, DeepSeekJudge, GoogleJudge, LocalJudge, OpenAIJudge };
export { buildJudgePrompt, getJudgePrompt, parseJudgeResponse } from "./base";
