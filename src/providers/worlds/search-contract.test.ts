import { describe, expect, it } from "bun:test"
import {
  dedupeRankedById,
  isRankedMode,
  sortRankedByScore,
  type SearchMode,
} from "./search-contract"

interface Fixture {
  id: string
  score: number | null
}

const mk = (id: string, score: number | null): Fixture => ({ id, score })

describe("isRankedMode", () => {
  it("treats fallback as unranked", () => {
    expect(isRankedMode("fallback")).toBe(false)
  })

  it("treats keyword / hybrid / semantic as ranked", () => {
    expect(isRankedMode("keyword")).toBe(true)
    expect(isRankedMode("hybrid")).toBe(true)
    expect(isRankedMode("semantic")).toBe(true)
  })

  it("treats an absent mode (local SDK backends) as ranked", () => {
    expect(isRankedMode(undefined)).toBe(true)
  })
})

describe("dedupeRankedById", () => {
  it("keeps the highest score per id in ranked mode", () => {
    const results = [mk("q1", 0.5), mk("q2", 0.9), mk("q1", 0.8), mk("q2", 0.4)]
    const deduped = dedupeRankedById(results, "keyword")
    expect(deduped.map((r) => r.id)).toEqual(["q1", "q2"])
    expect(deduped.find((r) => r.id === "q1")?.score).toBe(0.8)
    expect(deduped.find((r) => r.id === "q2")?.score).toBe(0.9)
  })

  it("keeps the first occurrence in fallback (unranked) mode", () => {
    const results = [mk("q1", null), mk("q2", null), mk("q1", null)]
    const deduped = dedupeRankedById(results, "fallback")
    expect(deduped.map((r) => r.id)).toEqual(["q1", "q2"])
  })

  it("keeps the first occurrence when ranked scores are null", () => {
    const results = [mk("q1", null), mk("q1", null)]
    const deduped = dedupeRankedById(results, "keyword")
    expect(deduped).toHaveLength(1)
    expect(deduped[0].score).toBeNull()
  })

  it("returns an empty list for empty input", () => {
    expect(dedupeRankedById([], "hybrid")).toEqual([])
  })

  it("drops later same-id results entirely (no partial dupes)", () => {
    const results = [mk("q1", 0.2), mk("q1", 0.9), mk("q1", 0.7)]
    const deduped = dedupeRankedById(results, "keyword")
    expect(deduped).toEqual([mk("q1", 0.9)])
  })
})

describe("sortRankedByScore", () => {
  it("sorts descending in ranked mode", () => {
    const results = [mk("a", 0.3), mk("b", 0.9), mk("c", 0.5)]
    expect(sortRankedByScore(results, "keyword").map((r) => r.id)).toEqual(["b", "c", "a"])
  })

  it("keeps original order in fallback (unranked) mode", () => {
    const results = [mk("a", null), mk("b", null), mk("c", null)]
    const sorted = sortRankedByScore(results, "fallback")
    expect(sorted).toEqual(results)
  })

  it("treats null scores as 0 in ranked mode without mutating input", () => {
    const results = [mk("a", 0.1), mk("b", null), mk("c", 0.4)]
    const sorted = sortRankedByScore(results, "keyword")
    expect(sorted.map((r) => r.id)).toEqual(["c", "a", "b"])
    expect(results.map((r) => r.id)).toEqual(["a", "b", "c"])
  })

  it("handles the hybrid mode with mixed score families", () => {
    const results: Array<Fixture & { scoreType?: string }> = [
      { id: "v2", score: 0.9, scoreType: "cosine" },
      { id: "k1", score: 0.6, scoreType: "rrf" },
      { id: "k2", score: 0.75, scoreType: "rrf" },
    ]
    const mode: SearchMode = "hybrid"
    expect(sortRankedByScore(results, mode).map((r) => r.id)).toEqual(["v2", "k2", "k1"])
  })
})
