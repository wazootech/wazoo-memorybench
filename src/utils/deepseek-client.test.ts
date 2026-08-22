import { afterEach, describe, expect, it, mock } from "bun:test"
import { DeepSeekClient } from "./deepseek-client"

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

function mockFetchOnce(status: number, body: unknown): void {
  globalThis.fetch = mock(
    async () => new Response(JSON.stringify(body), { status })
  ) as unknown as typeof fetch
}

describe("DeepSeekClient", () => {
  it("fails fast when no API key is configured", () => {
    expect(() => new DeepSeekClient({ apiKey: "" })).toThrow(/DEEPSEEK_API_KEY/)
    expect(() => new DeepSeekClient({ apiKey: undefined, baseUrl: "https://x" })).toThrow(
      /DEEPSEEK_API_KEY/
    )
  })

  it("sends thinking disabled top-level and json_object response format", async () => {
    let sentBody: Record<string, unknown> = {}
    globalThis.fetch = mock(async (_url: unknown, init?: RequestInit) => {
      sentBody = JSON.parse(String(init?.body))
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: '{"score":1,"label":"correct"}' } }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }),
        { status: 200 }
      )
    }) as unknown as typeof fetch

    const client = new DeepSeekClient({ apiKey: "ds-key" })
    const result = await client.chatCompletion({
      model: "deepseek-v4-flash",
      prompt: "Judge this.",
      maxTokens: 1000,
      temperature: 0,
      responseFormat: "json_object",
      thinking: "disabled",
    })

    expect(sentBody.model).toBe("deepseek-v4-flash")
    // Top-level, NOT nested under an `openai` provider namespace.
    expect(sentBody.thinking).toEqual({ type: "disabled" })
    expect(sentBody.response_format).toEqual({ type: "json_object" })
    expect(sentBody.max_tokens).toBe(1000)
    expect(sentBody.stream).toBe(false)
    expect(result.text).toBe('{"score":1,"label":"correct"}')
    expect(result.usage).toEqual({
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
    })
  })

  it("defaults thinking to disabled and supports full message arrays", async () => {
    let sentBody: Record<string, unknown> = {}
    globalThis.fetch = mock(async (_url: unknown, init?: RequestInit) => {
      sentBody = JSON.parse(String(init?.body))
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
        status: 200,
      })
    }) as unknown as typeof fetch

    const client = new DeepSeekClient({ apiKey: "ds-key" })
    await client.chatCompletion({
      model: "deepseek-v4-pro",
      messages: [
        { role: "system", content: "be brief" },
        { role: "user", content: "hi" },
      ],
    })

    expect(sentBody.thinking).toEqual({ type: "disabled" })
    expect(sentBody.messages).toHaveLength(2)
  })

  it("throws with response detail on non-OK responses", async () => {
    mockFetchOnce(401, { error: { message: "Invalid API key" } })
    const client = new DeepSeekClient({ apiKey: "bad-key" })
    await expect(
      client.chatCompletion({ model: "deepseek-v4-flash", prompt: "x" })
    ).rejects.toThrow(/HTTP 401/)
  })

  it("throws when neither prompt nor messages is provided", async () => {
    const client = new DeepSeekClient({ apiKey: "ds-key" })
    await expect(client.chatCompletion({ model: "deepseek-v4-flash" })).rejects.toThrow(
      /requires either prompt or messages/
    )
  })

  it("normalizes a trailing slash on the base URL", async () => {
    let calledUrl = ""
    globalThis.fetch = mock(async (url: unknown) => {
      calledUrl = String(url)
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
        status: 200,
      })
    }) as unknown as typeof fetch

    const client = new DeepSeekClient({
      apiKey: "ds-key",
      baseUrl: "https://api.deepseek.com/",
    })
    await client.chatCompletion({ model: "deepseek-v4-flash", prompt: "x" })
    expect(calledUrl).toBe("https://api.deepseek.com/chat/completions")
  })
})
