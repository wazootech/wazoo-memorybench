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
 *   --provider <deepseek|openai|gemini>  (default deepseek)
 *   --cache-dir <path>     (default data/cache/extraction-smoke)
 *   --warm                  run the cached pass too (always-on by default)
 *   --bench <n>             run n TRUE-COLD passes (fresh cache dir per pass,
 *                           real API call each) and report claim-count mean /
 *                           sample stddev / min / max so extraction variance is
 *                           quantified instead of surprising. Implies no warm
 *                           pass. Cost: ~1.4k tokens per pass on the mini
 *                           fixture (measured: 708 in / 668 out).
 *
 * Motivation: the same session extracted 7 claims / 64 quads (cached run) and
 * 9 claims / 80 quads (live run) across two days — LLM nondeterminism
 * concentrates in claim granularity. Benchmarks that assert exact claim
 * counts will flake; measure the variance first.
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

// --bench <n>: variance benchmark across n true-cold passes.
const benchRaw = arg("bench")
const benchRuns = benchRaw ? Number(benchRaw) : 0
if (benchRaw && (!Number.isInteger(benchRuns) || benchRuns < 2)) {
  console.error("--bench <n> requires an integer >= 2 (variance is undefined for n < 2)")
  process.exit(1)
}

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

/** One pass stats: everything measured is model-dependent or derived. */
interface PassStats {
  label: string
  ms: number
  turtleChars: number
  quadCount: number
  claimCount: number
  shaclValid: boolean
  shaclErrors: string[]
  entities: Record<string, number>
}

const ENTITY_CLASSES: [string, string][] = [
  ["Person", SCHEMA.Person],
  ["Organization", SCHEMA.Organization],
  ["Event", SCHEMA.Event],
  ["Action", SCHEMA.Action],
  ["MedicalCondition", SCHEMA.MedicalCondition],
]

/**
 * runPass extracts, parses, and analyzes one pass against a fresh cache dir.
 * Every pass with its own cacheDir is a real API call; reusing a cacheDir is
 * a cache hit (the warm pass).
 */
async function runPass(label: string, passCacheDir: string): Promise<PassStats> {
  await mkdir(passCacheDir, { recursive: true })
  const t0 = performance.now()
  const turtle = await extractFactsToTurtle(key, session, {
    cacheDir: passCacheDir,
    provider: provider as "deepseek",
  })
  const ms = performance.now() - t0

  const store = turtle.trim() ? parseTurtleToDataset(turtle) : null
  const quadCount = store?.size ?? 0
  // Claims are nodes carrying worlds:claimText — count distinct subjects, not
  // every provenance reference to them.
  const claimCount = store
    ? new Set(store.getQuads(null, WORLDS.claimText, null).map((q) => q.subject.value)).size
    : 0

  const entities: Record<string, number> = {}
  let shaclValid = false
  let shaclErrors: string[] = ["empty turtle"]
  if (turtle.trim() && store) {
    const shacl = await validateShaclGraph(turtle)
    shaclValid = shacl.valid
    shaclErrors = shacl.errors
    for (const [name, iri] of ENTITY_CLASSES) {
      const n = store.getQuads(null, RDF.type, iri as never).length
      if (n > 0) entities[name] = n
    }
  }

  return { label, ms, turtleChars: turtle.length, quadCount, claimCount, shaclValid, shaclErrors, entities }
}

function printPassLine(s: PassStats): void {
  console.log(
    `${s.label.padEnd(6)} ${s.ms.toFixed(0).padStart(6)} ms | turtle ${s.turtleChars} chars | ${s.quadCount} quads | ${s.claimCount} claims | SHACL ${s.shaclValid ? "PASS" : "FAIL"}`
  )
  if (!s.shaclValid) {
    console.log(s.shaclErrors.map((e) => `  ${e}`).join("\n"))
  }
}

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length
}

/** Sample stddev (n-1 denominator); the unbiased estimator for run variance. */
function stddev(xs: number[]): number {
  if (xs.length < 2) return 0
  const m = mean(xs)
  return Math.sqrt(xs.reduce((acc, x) => acc + (x - m) ** 2, 0) / (xs.length - 1))
}

if (benchRuns >= 2) {
  // ---- Benchmark mode: n true-cold passes, variance report ----
  const passes: PassStats[] = []
  const benchStart = performance.now()
  for (let i = 1; i <= benchRuns; i++) {
    const passDir = join(cacheDir, "bench", `run-${i}`)
    const s = await runPass(i === 1 ? "COLD" : `COLD${i}`, passDir)
    printPassLine(s)
    passes.push(s)
  }
  const benchMs = performance.now() - benchStart
  console.log("─".repeat(64))

  const claims = passes.map((p) => p.claimCount)
  const quads = passes.map((p) => p.quadCount)
  const entitiesByClass = new Map<string, number[]>()
  for (const [name] of ENTITY_CLASSES) {
    const values = passes.map((p) => p.entities[name] ?? 0)
    if (values.some((v) => v > 0)) entitiesByClass.set(name, values)
  }

  const fmt = (xs: number[]) =>
    `${mean(xs).toFixed(2)} ± ${stddev(xs).toFixed(2)} (min ${Math.min(...xs)}, max ${Math.max(...xs)})`

  console.log(`BENCH  ${benchRuns} cold passes in ${(benchMs / 1000).toFixed(1)}s`)
  console.log(`claims   mean ± stddev: ${fmt(claims)}`)
  console.log(`quads    mean ± stddev: ${fmt(quads)}`)
  for (const [name, values] of entitiesByClass) {
    console.log(`entity ${name.padEnd(16)} ${fmt(values)}`)
  }
  const shaclPasses = passes.filter((p) => p.shaclValid).length
  console.log(`SHACL    ${shaclPasses}/${passes.length} passes valid`)

  const failed = passes.some((p) => !p.shaclValid) || claims.every((c) => c === 0)
  if (failed) {
    console.error("BENCH FAILED")
    process.exit(1)
  }
  console.log(
    `BENCH PASS — variance quantified across ${benchRuns} cold passes` +
      (claims.every((c) => c === claims[0]) ? " (stable claim counts)" : " (claim counts vary — pin caches or average for benchmarks)")
  )
  process.exit(0)
}

// ---- Default single-pass smoke ----
const opts = { cacheDir, provider: provider as "deepseek" }

// ---- Cold pass: real API call ----
const t0 = performance.now()
const turtle = await extractFactsToTurtle(key, session, opts)
const coldMs = performance.now() - t0

const store = turtle.trim() ? parseTurtleToDataset(turtle) : null
const quadCount = store?.size ?? 0
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

  const counts: [string, number][] = ENTITY_CLASSES.map(([name, iri]) => [
    name,
    store.getQuads(null, RDF.type, iri as never).length,
  ])
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
