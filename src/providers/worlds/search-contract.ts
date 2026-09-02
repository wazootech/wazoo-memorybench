/**
 * Hosted search contract helpers (worlds-api#30 / worlds-api#74).
 *
 * The hosted search response carries a required `mode`
 * (`semantic | keyword | hybrid | fallback`) and results with a deterministic
 * `id`, nullable `score`, and `scoreType`. The local SDK backends predate that
 * surface: they always emit ranked numeric scores and no mode signal. These
 * helpers make consumption safe for BOTH shapes — ranked semantics come from
 * `mode`, never from an assumption that search is semantic/vector.
 *
 * **D8 boundary**: search `score` measures retrieval relevance only. It must
 * never be reused as an answer-quality signal; the SPARQL fact-claim merge in
 * the Worlds provider happens downstream of scoring and is not score-based.
 */

/** Search modes the hosted contract can report. */
export type SearchMode = "semantic" | "keyword" | "hybrid" | "fallback"

/**
 * Whether a result list carries ordering meaning. `"fallback"` (SQL LIKE)
 * results are unranked: `score` is null and carries no ordering meaning.
 * Every other mode — and an absent mode (local SDK backends) — is ranked.
 */
export function isRankedMode(mode: SearchMode | undefined): boolean {
  return mode !== "fallback"
}

/** Minimal surface a ranked candidate needs for id dedup / score ordering. */
export interface RankedCandidate {
  id: string
  score: number | null
}

/**
 * Deduplicates ranked search results on the contract's deterministic `id`
 * (shared across backends via buildSearchResultId). In ranked mode the
 * highest score wins per id; in unranked mode (or when either score is null)
 * the first occurrence wins and relative order is preserved.
 */
export function dedupeRankedById<T extends RankedCandidate>(results: T[], mode?: SearchMode): T[] {
  const ranked = isRankedMode(mode)
  const seen = new Map<string, T>()
  for (const r of results) {
    const existing = seen.get(r.id)
    if (!existing) {
      seen.set(r.id, r)
    } else if (ranked && existing.score !== null && r.score !== null && r.score > existing.score) {
      seen.set(r.id, r)
    }
  }
  return [...seen.values()]
}

/**
 * Stable score ordering: ranked lists sort by score descending (null scores
 * treated as 0), unranked lists keep their original order. The sort is stable,
 * so equal-scored dupes retain insertion order.
 */
export function sortRankedByScore<T extends RankedCandidate>(results: T[], mode?: SearchMode): T[] {
  if (!isRankedMode(mode)) return results
  return [...results].sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
}
