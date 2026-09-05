import { describe, expect, it } from "bun:test"
import { sanitizePathSegment } from "./cache-path"

describe("sanitizePathSegment", () => {
  it("replaces Windows-invalid characters with underscores", () => {
    expect(sanitizePathSegment("qwen2.5-coder:7b")).toBe("qwen2.5-coder_7b")
    expect(sanitizePathSegment("nomic-embed-text:v1.5")).toBe("nomic-embed-text_v1.5")
  })

  it("keeps already-safe names unchanged", () => {
    for (const name of ["gemini", "openai", "ollama", "deepseek-v4-flash", "nomic-embed-text"]) {
      expect(sanitizePathSegment(name)).toBe(name)
    }
  })

  it("neutralizes every Windows-forbidden character", () => {
    const input = 'a:b\c/d*e?f"g<h>i|j'
    const out = sanitizePathSegment(input)
    expect(out).not.toMatch(/[:\/*?"<>|]/)
    expect(out.length).toBe(input.length)
  })
})
