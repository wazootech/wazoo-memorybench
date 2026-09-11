# Worlds Provider (`-p worlds`)

Adapter for `@worlds/sdk` (graph-backed memory / RAG provider) in MemoryBench.

## Environment variables

| Variable | Required | Description |
| --- | --- | --- |
| `GOOGLE_API_KEY` / `GOOGLE_GENERATIVE_AI_API_KEY` | When using Gemini | Powers fact extraction or Gemini judge/answer models. |
| `ANTHROPIC_API_KEY` | Alt judge | Alternative judge backend. |
| `DEEPSEEK_API_KEY` | When using DeepSeek extraction or judge | DeepSeek extraction/judge credentials. |
| `TFJS_USE_MODEL_DIR` | Optional | Local TF.js USE model directory; defaults to ignored `data/models/tfjs-use`. |
| `EXTRACTION_PROVIDER` | Optional | `deepseek` (default), `gemini`, `openai`, or `none`. |

WorldsProvider has one embedding path: the 512-dimensional, CPU-friendly TF.js
Universal Sentence Encoder Lite adapter. Download its model artifacts once with
`bun run models:tfjs-use`; the ignored files are reused across runs. Verify the
cached adapter with `bun run smoke:tfjs-use`. Embedding does not require an
external model server or embedding API.

## Phase mapping

| Pipeline phase | Worlds mapping |
| :------------- | :------------- |
| **Ingest** | Session messages → RDF Turtle → `client.import()`; strict structural and SHACL validation blocks the session before either raw or extracted RDF is imported. |
| **Extract** | Optional LLM JSON claims → a constrained domain RDF emitter; malformed extraction, invalid RDF, or extraction failure is fatal unless `EXTRACTION_PROVIDER=none`. |
| **Index** | Incremental projection during each committed `client.import()`; `reindexWorld` is reserved for repair, audit, or bulk-import completion. TF.js USE supplies 512-dimensional vectors. |
| **Search** | Hybrid `client.search()` plus a bounded SPARQL fact lookup on `worlds:Claim`; raw ranked hits are returned before the fact-claim complement. |
| **Answer** | MemoryBench answer layer — configurable LLM via `-m`. |
| **Evaluate** | MemoryBench judge — MemScore reporting via `-j`. |

## RDF and SHACL scope

The extraction prompt and emitter are **not** a generalized arbitrary-RDF or
arbitrary-ontology compiler. They currently recognize a fixed set of domain
classes (`Person`, `Event`, `Action`, `MedicalCondition`, `Organization`) and
map other supported claim categories into the `worlds:Claim` hierarchy. The
SHACL shapes likewise cover the session/message graph and those domain classes.
Adding another vocabulary or ontology requires extending the extraction schema,
emitter, ontology constants, and shapes; arbitrary RDF returned by a model is
not accepted as-is.

SHACL is a hard ingestion gate. The provider validates the session/message RDF
and extracted RDF before import. Cached extracted Turtle is revalidated before
reuse, and a SHACL engine failure is also fatal rather than being treated as a
successful validation.

## Storage and reproducibility

Each MemoryBench `containerTag` gets its own file-backed SQLite database under
`data/providers/worlds/`. This is deliberate: it prevents cross-question state
leaks while preserving graph data, extracted claims, and indexed state for
inspection and resumed runs. The in-memory Worlds store remains useful for fast
unit and mechanical smoke tests, but it should not be the LoCoMo benchmark
backend when postmortem inspection matters.

Extraction and embedding caches are content-addressed under `data/cache/`, so a
new run ID can reuse successful work without silently reusing output from a
different provider/model or model directory.

## Running benchmark tests

```bash
bun install
cp .env.example .env.local   # add API keys

# 1. Run LoCoMo benchmark (limited sample)
bun run src/index.ts run -p worlds -b locomo -l 5 -r smoke-locomo-001 -j deepseek-v4-flash -m gpt-4o

# 2. Run LongMemEval benchmark
bun run src/index.ts run -p worlds -b longmemeval -l 5 -r smoke-lme-001 -j deepseek-v4-flash -m gpt-4o

# 3. Iterate on search/answer/evaluate — reuses ingested data and indexes
bun run src/index.ts run -r smoke-lme-001 -f search -j deepseek-v4-flash -m gpt-4o
```

Use `-f search` to skip ingest and indexing on subsequent runs. The file-backed
SQLite databases persist under `data/providers/worlds/`, so only answer and
judge calls are repeated. Change `-j` or `-m` between iterations to compare
models against the same indexed data.

## Design notes

- **Persistent storage**: `@worlds/sqlite` uses the Wazoo SPARQL engine over
  `bun:sqlite`; the database files remain available for debugging and
  postmortem analysis.
- **Hybrid search**: The Worlds search index combines FTS5 with the 512-dimensional TF.js USE vectors. Model artifacts are local and cached; no external embedding service is part of this provider.
- **Per-term fallback**: FTS5 uses implicit AND between terms; the provider
  broadens with per-term OR merge when the full query matches nothing.
- **Fact layer + SPARQL**: Ingest writes `worlds:*Claim` triples
  (`claimText`, `claimSubject`, …). Search runs a bounded SPARQL query with
  AND/OR keyword matching and proper-noun filters, then places facts after the
  first 10 raw results with deduplication.
- **Agentic tools**: the local Worlds tool surface is available for separate
  agent-tool smoke workflows. The standard MemoryBench provider path does not
  itself run an agentic SPARQL reasoning loop.
- **Judge rubric**: Default/temporal judge prompts include semantic-equivalence
  rules (`src/prompts/defaults.ts`) to reduce flip-flops on paraphrases.
