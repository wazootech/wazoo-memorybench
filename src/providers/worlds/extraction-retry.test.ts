import { afterEach, describe, expect, it, mock } from "bun:test"
import { config } from "../../utils/config"
import { extractFactsToTurtle } from "./extraction"

const originalFetch = globalThis.fetch
const originalDeepSeekApiKey = config.deepseekApiKey

afterEach(() => {
  globalThis.fetch = originalFetch
  config.deepseekApiKey = originalDeepSeekApiKey
})

describe("DeepSeek extraction retries", () => {
  it("increases the output budget and retries malformed JSON", async () => {
    const requestBodies: Record<string, unknown>[] = []
    let requestCount = 0
    config.deepseekApiKey = "test-key"
    globalThis.fetch = mock(async (_url: unknown, init?: RequestInit) => {
      requestCount += 1
      requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      const content =
        requestCount === 1
          ? '[{"domainClass":"Fact","subject":"Alice"'
          : '[{"domainClass":"Fact","subject":"Alice","claimText":"Alice likes tea."}]'
      return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 })
    }) as unknown as typeof fetch

    const turtle = await extractFactsToTurtle(
      "",
      {
        sessionId: "retry-session",
        messages: [{ role: "user", content: "Alice likes tea." }],
      },
      { provider: "deepseek" }
    )

    expect(requestCount).toBe(2)
    expect(requestBodies[0]?.max_tokens).toBe(6000)
    expect(String((requestBodies[1]?.messages as { content: string }[])[0]?.content)).toContain(
      "previous response was incomplete or malformed"
    )
    expect(turtle).toContain("Alice likes tea.")
  })
})
