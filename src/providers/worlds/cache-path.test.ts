import { describe, expect, it } from "bun:test"
import { sanitizePathSegment } from "./cache-path"

describe("sanitizePathSegment", () => {
  it("replaces Windows-invalid characters with underscores", () => {
    expect(sanitizePathSegment("qwen2.5-coder:7b")).toBe("qwen2.5-coder_7b")
    expect(sanitizePathSegment("universal-sentence-encoder-lite:v1.5")).toBe(
      "universal-sentence-encoder-lite_v1.5"
    )
  })

  it("keeps already-safe names unchanged", () => {
    for (const name of ["tfjs-use", "universal-sentence-encoder-lite", "deepseek-v4-flash"]) {
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
