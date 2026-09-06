/**
 * Minimal-token RDF extraction smoke.
 *
 * Runs ONE tiny session (3 messages, ~70 tokens) through the real DeepSeek
 * extraction path — extractFactsToTurtle(provider: "deepseek") — exactly as
 * WorldsProvider.ingest calls it, then analyzes the resulting graph LOCALLY:
 * SHACL validation + entity-class counts. Analysis costs zero LLM tokens.
 *
 * Repeat runs are ~free: the extraction cache is content-addressed per
 * session, so a second run is a cache hit (no API call).
 *
 *   DEEPSEEK_API_KEY=sk-... bun run scripts/smoke-extraction.ts
 *
 * Flags:
 *   --provider <deepseek|openai|ollama|gemini>  (default deepseek)
 *   --cache-dir <path>     (default data/cache/extraction-smoke)
 *   --warm                  run the cached pass too (always-on by default)
 */
import { mkdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { extractFactsToTurtle } from "../src/providers/worlds/extraction"
import { parseTurtleToDataset, validateShaclGraph } from "../src/providers/worlds/shapes"
import { RDF, SCHEMA, WORLDS } from "../src/providers/worlds/ontology"
import { logger } from "../src/utils/logger"

logger.setLevel("debug") // surfaces the "DeepSeek extraction usage: N in / M out" line

const FIXTURE = join(import.meta.dir, "..", "fixtures", "mini-extraction-session.json")
const DEFAULT_CACHE_DIR = join(process.cwd(), "data", "cache", "extraction-smoke")

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

const provider = (arg("provider") as "deepseek" | undefined) || "deepseek"
const cacheDir = arg("cache-dir") || DEFAULT_CACHE_DIR

const key = process.env.DEEPSEEK_API_KEY
if (!key) {
  console.error(
    "Missing DEEPSEEK_API_KEY. Set it via env or an --env-file:\n" +
      "  DEEPSEEK_API_KEY=sk-... bun run scripts/smoke-extraction.ts"
  )
  process.exit(1)
}

const session = JSON.parse(await readFile(FIXTURE, "utf-8")) as {
  sessionId: string
  metadata?: Record<string, unknown>
  messages: { role: string; content: string; speaker?: string }[]
}

const convTokens = session.messages.reduce((n, m) => n + m.content.trim().split(/\s+/).length, 0)
console.log(
  `Session: ${session.sessionId} | ${session.messages.length} messages | ~${convTokens} conv tokens`
)
console.log(`Provider: ${provider} | cache: ${cacheDir}`)
console.log("─".repeat(64))

await mkdir(cacheDir, { recursive: true })

const opts = { cacheDir, provider: provider as "deepseek" }

// ---- Cold pass: real API call ----
const t0 = performance.now()
const turtle = await extractFactsToTurtle(key, session, opts)
const coldMs = performance.now() - t0

const store = turtle.trim() ? parseTurtleToDataset(turtle) : null
const quadCount = store?.size ?? 0
// Claims are nodes carrying worlds:claimText — count distinct subjects, not
// every provenance reference to them.
const claimCount = store
  ? new Set(store.getQuads(null, WORLDS.claimText, null).map((q) => q.subject.value)).size
  : 0

console.log(
  `COLD  ${coldMs.toFixed(0).padStart(6)} ms | turtle ${turtle.length} chars | ${quadCount} quads | ${claimCount} claims`
)

// ---- Local analysis: zero LLM tokens ----
let shacl = { valid: false, errors: ["empty turtle"] as string[] }
if (turtle.trim() && store) {
  shacl = await validateShaclGraph(turtle)
  console.log(
    `SHACL ${shacl.valid ? "PASS" : "FAIL"}${shacl.errors.length ? `\n${shacl.errors.map((e) => `  ${e}`).join("\n")}` : ""}`
  )

  const counts: [string, number][] = [
    ["Person", store.getQuads(null, RDF.type, SCHEMA.Person).length],
    ["Organization", store.getQuads(null, RDF.type, SCHEMA.Organization).length],
    ["Event", store.getQuads(null, RDF.type, SCHEMA.Event).length],
    ["Action", store.getQuads(null, RDF.type, SCHEMA.Action).length],
    ["MedicalCondition", store.getQuads(null, RDF.type, SCHEMA.MedicalCondition).length],
  ]
  const entityLine = counts
    .filter(([, n]) => n > 0)
    .map(([c, n]) => `${c}: ${n}`)
    .join(" | ")
  console.log(`Entities: ${entityLine}`)
  console.log("─".repeat(64))

  // ---- Warm pass: cache hit, no API call ----
  const t1 = performance.now()
  const cached = await extractFactsToTurtle(key, session, opts)
  const warmMs = performance.now() - t1
  console.log(
    `WARM  ${warmMs.toFixed(1).padStart(6)} ms | ${cached === turtle ? "byte-identical" : "DIFFERS!"} | $0 (cache hit)`
  )
}

const failed = !turtle.trim() || claimCount === 0
const shaclResult = shacl
if (failed || !shaclResult.valid) {
  console.error("SMOKE FAILED")
  process.exit(1)
}
console.log("SMOKE PASS — extraction pipeline healthy on a minimal sample")
