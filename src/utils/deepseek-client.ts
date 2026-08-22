import { config } from "./config";

export interface DeepSeekChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface DeepSeekChatOptions {
  model: string;
  /** Either a single `prompt` (wrapped as a user message) or full `messages`. */
  prompt?: string;
  messages?: DeepSeekChatMessage[];
  maxTokens?: number;
  temperature?: number;
  /** DeepSeek supports `response_format: { type: "json_object" }`. */
  responseFormat?: "json_object";
  /**
   * deepseek-v4-* are reasoning models. `thinking` MUST be sent top-level in
   * the chat-completions body — the AI SDK OpenAI provider validates
   * `providerOptions.openai` against a strict schema and silently strips
   * unknown keys, so the ai-sdk route never reaches the API. Defaults to
   * disabled so reasoning tokens cannot burn the max-tokens budget.
   */
  thinking?: "enabled" | "disabled";
  signal?: AbortSignal;
}

export interface DeepSeekUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export interface DeepSeekChatResult {
  text: string;
  usage?: DeepSeekUsage;
}

/**
 * Minimal raw-fetch client for DeepSeek's OpenAI-compatible Chat Completions
 * API. Exists because the AI SDK path silently drops DeepSeek-specific
 * top-level body params (notably `thinking`); raw fetch is the proven
 * pattern already used by `extraction.ts` and the agent smoke script.
 *
 * Key/base URL resolve from `config` (DEEPSEEK_API_KEY / DEEPSEEK_BASE_URL).
 * A missing key fails fast with a clear error instead of silently falling
 * back to OPENAI_API_KEY.
 */
export class DeepSeekClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(opts?: { apiKey?: string; baseUrl?: string }) {
    this.apiKey = opts?.apiKey ?? config.deepseekApiKey;
    if (!this.apiKey) {
      throw new Error(
        "DEEPSEEK_API_KEY is not set — refusing to borrow OPENAI_API_KEY. " +
          "Set DEEPSEEK_API_KEY (and DEEPSEEK_BASE_URL if not using api.deepseek.com).",
      );
    }
    this.baseUrl =
      (opts?.baseUrl ?? config.deepseekBaseUrl ?? "https://api.deepseek.com")
        .replace(
          /\/$/,
          "",
        );
  }

  /** Single non-streaming chat completion against `/chat/completions`. */
  async chatCompletion(opts: DeepSeekChatOptions): Promise<DeepSeekChatResult> {
    const messages: DeepSeekChatMessage[] = opts.messages ??
      (opts.prompt !== undefined
        ? [{ role: "user", content: opts.prompt }]
        : []);
    if (messages.length === 0) {
      throw new Error(
        "DeepSeek chat completion requires either prompt or messages",
      );
    }

    const body: Record<string, unknown> = {
      model: opts.model,
      messages,
      stream: false,
    };
    if (opts.maxTokens !== undefined) body.max_tokens = opts.maxTokens;
    if (opts.temperature !== undefined) body.temperature = opts.temperature;
    if (opts.responseFormat === "json_object") {
      body.response_format = { type: "json_object" };
    }
    body.thinking = { type: opts.thinking ?? "disabled" };

    const resp = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: opts.signal,
    });
    if (!resp.ok) {
      const detail = (await resp.text()).slice(0, 500);
      throw new Error(
        `DeepSeek chat completion HTTP ${resp.status}: ${detail}`,
      );
    }
    const data = (await resp.json()) as {
      choices?: { message?: { content?: string } }[];
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
      };
    };
    const usage = data.usage;
    return {
      text: data.choices?.[0]?.message?.content ?? "",
      usage: usage
        ? {
          promptTokens: usage.prompt_tokens,
          completionTokens: usage.completion_tokens,
          totalTokens: usage.total_tokens,
        }
        : undefined,
    };
  }
}
