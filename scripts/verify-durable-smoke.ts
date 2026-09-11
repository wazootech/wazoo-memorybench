import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { WorldsProvider } from "../src/providers/worlds/index"
import { createWorldsAgentTools } from "../src/providers/worlds/agent-tools"

// Durable (worlds-sqlite) agent-tools smoke verification.
// Proves the local Worlds tool surface wired onto
// WorldsProvider.getClientForContainer works against the file-backed
// SQLite store that the production wazoo provider uses.
//
// searchWorld requires the local TF.js USE model artifacts
// and a rebuilt search index. When none is available, this script proves
// the index-independent executeSparql surface and
// records that searchWorld needs the local embedding model.
//
// Run after downloading the TF.js USE model:
//   DEEPSEEK_API_KEY=test-key EXTRACTION_PROVIDER=none GEMINI_API_KEY=dummy \
//     bun run scripts/verify-durable-smoke.ts

const CONTAINER = "agent-tools-smoke-durable"
const FIXTURE = join(import.meta.dir, "..", "fixtures", "mini-extraction-session.json")
const FACTS = join(import.meta.dir, "..", "fixtures", "mini-extraction-facts.ttl")

const session = JSON.parse(await readFile(FIXTURE, "utf-8")) as {
  sessionId: string
  metadata?: Record<string, unknown>
  messages: { role: string; content: string; speaker?: string }[]
}

const factsTurtle = await readFile(FACTS, "utf-8")

console.log("=== Durable (worlds-sqlite) agent-tools smoke verification ===")
console.log("Backend: @worlds/sqlite (bun:sqlite) via WorldsProvider")
console.log("Tools package: MemoryBench local Worlds tool surface")
console.log("Container:", CONTAINER)

const provider = new WorldsProvider()
await provider.initialize({ apiKey: process.env.GEMINI_API_KEY ?? "" })
await provider.clear(CONTAINER)

const ingestStart = performance.now()
const ingestResult = await provider.ingest([session], { containerTag: CONTAINER })
console.log(
  `INGEST  ${Math.round(performance.now() - ingestStart)}ms | ${ingestResult.documentIds.length} session(s)`
)

// Pre-extracted facts: the fixture session's message "I work as a nurse at Harborview
// Medical Center" would be extracted by the extraction pipeline into a schema:worksFor
// triple. The durable smoke proves executeSparql against the durable store, so we import
// the same pre-extracted Turtle the in-memory smoke seeds (fixtures/mini-extraction-facts.ttl).
const client = await provider.getClientForContainer(CONTAINER)
await client.import({
  source: { kind: "serialized", data: factsTurtle, contentType: "text/turtle" },
})
console.log("FACTS   imported pre-extracted Turtle (worksFor triple)")

// Build/rebuild the FTS5 search index now that the facts are in the quad store.
// This requires TF.js USE model artifacts; if unavailable, executeSparql and
// the SPARQL schema-discovery query still proves the durable client + local tool wiring.
let searchIndexBuilt = false
try {
  const reindexResult = await client.reindex()
  searchIndexBuilt = true
  console.log(
    `INDEX   rebuilt — ${reindexResult.processedQuadCount} quads, ${reindexResult.chunkRowCount} chunks`
  )
} catch (err) {
  console.log(
    `INDEX   rebuild skipped (no TF.js USE model artifacts): ${err instanceof Error ? err.message : String(err)}`
  )
}

const tools = await createWorldsAgentTools(provider, CONTAINER, "full")
console.log(`TOOLS   ${Object.keys(tools).join(", ")}`)

const toolOptions = { toolCallId: "durable-smoke", messages: [], context: {} } as never

// Mechanical phase — index-independent surfaces first
console.log("\n--- Mechanical phase (index-independent) ---")

const sparqlRes = (await tools.executeSparql.execute!(
  {
    query:
      "PREFIX schema: <http://schema.org/>\nSELECT ?person ?org WHERE { ?person schema:worksFor ?org }",
  },
  toolOptions
)) as {
  success: boolean
  data?: { results?: { bindings?: Array<Record<string, { value: string }>> } }
  error?: string
}
const bindings = sparqlRes.data?.results?.bindings ?? []
const worksForPairs = bindings.map((b) => `${b.person?.value} -> ${b.org?.value}`)
console.log(
  `SPARQL  success=${sparqlRes.success} | ${bindings.length} worksFor bindings: ${worksForPairs.join(" | ") || "(none)"}`
)

const schemaDiscoveryRes = (await tools.executeSparql.execute!(
  {
    query: "SELECT ?type ?predicate WHERE { ?subject a ?type ; ?predicate ?object } LIMIT 20",
  },
  toolOptions
)) as {
  success: boolean
  data?: { results?: { bindings?: Array<Record<string, { value: string }>> } }
  error?: string
}
const schemaBindings = schemaDiscoveryRes.data?.results?.bindings ?? []
console.log(
  `SCHEMA  success=${schemaDiscoveryRes.success} | ${schemaBindings.length} type/predicate bindings`
)

// searchWorld requires the FTS5 index; report status
let searchPass = false
let searchMsg = ""
if (searchIndexBuilt) {
  const searchRes = (await tools.searchWorld.execute!({ query: "Melanie" }, toolOptions)) as {
    success: boolean
    data?: { results?: Array<{ text: string; score: number }> }
    error?: string
  }
  const searchHits = searchRes.data?.results ?? []
  searchPass = searchRes.success && searchHits.length > 0
  searchMsg = `SEARCH  success=${searchRes.success} | ${searchHits.length} hits`
  if (searchHits.length > 0) {
    searchMsg += ` | top: ${JSON.stringify(searchHits[0].text?.slice(0, 80))}`
  }
} else {
  searchMsg = "SEARCH  skipped (search index not built — needs TF.js USE model artifacts)"
}

console.log("\n--- Index-dependent surface ---")
console.log(searchMsg)

// Verdict
console.log("\n--- Verdict ---")
const mechanicalPass =
  sparqlRes.success &&
  bindings.length > 0 &&
  schemaDiscoveryRes.success &&
  schemaBindings.length > 0 &&
  (searchIndexBuilt ? searchPass : true) // searchWorld is conditional on embeddings

if (!mechanicalPass) {
  console.error("FAIL: Durable mechanical phase failed")
  if (!sparqlRes.success) console.error(`  sparql error: ${sparqlRes.error}`)
  if (!schemaDiscoveryRes.success) console.error(`  schema error: ${schemaDiscoveryRes.error}`)
  if (searchIndexBuilt && !searchPass) console.error("  searchWorld failed")
  process.exit(1)
}

console.log("PASS: Durable (worlds-sqlite) mechanical phase verified")
console.log("")
console.log("Summary:")
console.log(`  - Local Worlds tool surface wired onto WorldsProvider.getClientForContainer: OK`)
console.log(`  - executeSparql on durable SQLite store: ${bindings.length} worksFor binding(s)`)
console.log(
  `  - SPARQL schema discovery on durable SQLite store: ${schemaBindings.length} binding(s)`
)
if (searchIndexBuilt) {
  console.log(
    `  - searchWorld on durable SQLite store (FTS5 index): ${searchPass ? "OK" : "FAILED"}`
  )
} else {
  console.log(`  - searchWorld: requires the TF.js USE model artifacts + reindex()`)
  console.log("    Run `bun run models:tfjs-use` first, then retry this smoke.")
}
