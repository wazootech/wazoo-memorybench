# Worlds Provider (`-p worlds`)

Adapter for `@worlds/sdk` (graph-backed memory / RAG provider) in MemoryBench.

## Environment variables

| Variable                                          | Required         | Description                                                                       |
| ------------------------------------------------- | ---------------- | --------------------------------------------------------------------------------- |
| `GOOGLE_API_KEY` / `GOOGLE_GENERATIVE_AI_API_KEY` | **Yes**          | Gemini embeddings for search vectors, fact extraction at ingest, judge/answer LLM |
| `OPENAI_API_KEY`                                  | For judge/answer | Used by the judge LLM when evaluating answers                                     |
| `ANTHROPIC_API_KEY`                               | Alt judge        | Alternative judge backend                                                         |

`GOOGLE_GENERATIVE_AI_API_KEY` powers the embedding service
(`gemini-embedding-2`), per-session **fact extraction** (Gemini JSON → RDF
claims), and Gemini judge/answer models. Extracted claims are cached on disk
under `data/providers/worlds/claims-cache/<containerTag>/` (content-addressed)
to speed re-ingestion. The Google judge uses **3-pass majority vote** for more
stable scores (see `src/judges/google.ts`). File-backed LibSQL databases live
under `data/providers/worlds/*.db` so resumed runs can reuse ingested graph
data.

## Phase mapping

| Pipeline phase | Worlds mapping                                                                                                                   |
| :------------- | :------------------------------------------------------------------------------------------------------------------------------- |
| **Ingest**     | Session messages → RDF Turtle → `client.import()`; optional **LLM fact claims** (second import) with on-disk cache               |
| **Index**      | `client.rebuildSearchIndex()` — FTS5 + 768-dim vector chunks; embedding calls are rate-limited globally                          |
| **Search**     | Hybrid `client.search()` + **SPARQL fact lookup** on `worlds:Claim` (entity + keyword AND/OR); results interleaved with raw hits |
| **Answer**     | MemoryBench judge layer (unchanged) — configurable LLM via `-j`                                                                  |
| **Evaluate**   | MemoryBench judge (unchanged) — MemScore reporting                                                                               |

## Upstream baseline status

This fork tracks upstream
[`supermemoryai/memorybench`](https://github.com/supermemoryai/memorybench)
`main` (baseline @ `118209a`). Upstream unmerged feature branches
(`codex/beam-integration-hardening` and `feat/longmemeval-v2-memorybench`)
contain upcoming BEAM and LongMemEval-V2 contracts.

## Running benchmark tests

```bash
bun install
cp .env.example .env.local   # add API keys

# 1. Run LoCoMo benchmark (limited sample)
bun run src/index.ts run -p worlds -b locomo -l 5 -r smoke-locomo-001 -j gemini-2.5-flash -m gemini-2.5-flash

# 2. Run LongMemEval benchmark
bun run src/index.ts run -p worlds -b longmemeval -l 5 -r smoke-lme-001 -j gemini-2.5-flash -m gemini-2.5-flash

# 3. Iterate on search/answer/evaluate — reuses ingested data, zero re-embedding cost
bun run src/index.ts run -r smoke-lme-001 -f search -j gemini-2.5-flash -m gemini-2.5-flash
```

Use `-f search` to skip ingest and indexing on subsequent runs. The file-backed
LibSQL databases persist under `data/providers/worlds/`, so only the LLM
answer + judge calls are repeated. Change `-j` or `-m` between iterations to
compare different models against the same indexed data.

## Design notes

- **File-backed storage**: each MemoryBench `containerTag` gets its own LibSQL
  file under `data/providers/worlds/`, avoiding cross-question state leaks while
  preserving data for resumed runs.
- **Hybrid search**: With a Google API key, search uses `gemini-embedding-2`
  (768-dim) plus FTS5, fused via RRF. Without the key, search is keyword-only.
- **Per-term fallback**: FTS5 uses implicit AND between terms; the provider
  broadens with per-term OR merge when the full query matches nothing.
- **Fact layer + SPARQL**: Ingest writes `worlds:*Claim` triples (`claimText`,
  `claimSubject`, …). Search runs a bounded SPARQL query (AND keywords, OR
  fallback, proper-noun filters) and places facts after the first 10 raw results
  (with dedup).
- **Judge rubric**: Default/temporal judge prompts include semantic-equivalence
  rules (`src/prompts/defaults.ts`) to reduce flip-flops on paraphrases.
