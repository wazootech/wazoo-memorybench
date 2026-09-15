/**
 * Comunica-vs-Wazoo SPARQL perf benchmark for the #25 acceptance checklist
 * (follow-up wazoo-memorybench#63).
 *
 * Runs the harness's exact query surface (mirrored from
 * src/providers/worlds/index.ts: the fact-claim FILTER/CONTAINS query, the
 * VALUES enrichment query, COUNT/GROUP BY schema discovery, and the
 * multi-hop Event->Person join) over the 5 conv-26 smoke DBs, timing every
 * query, and writes a JSON artifact under data/bench-artifacts/conv26-perf/.
 *
 * The two engine trees must query byte-identical DB content (seeded by
 * scripts/seed-conv26-smoke.ts: one shared DeepSeek extraction + the same
 * deterministic session Turtle serializer on both sides).
 *
 *   # On the main (Wazoo) tree:
 *   bun run scripts/bench-conv26-sparql.ts --engine=wazoo
 *
 *   # On the pre-#33 worktree (ComunicaSparqlEngine over LibsqlStore):
 *   bun run scripts/bench-conv26-sparql.ts --engine=comunica
 *
 * Result multisets are fingerprinted (sorted row values, sha256) so the
 * artifact can assert the engines return identical results, not just similar
 * timings.
 */
import { Database } from "bun:sqlite"
import { createHash } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"

const ENGINE = process.argv.includes("--engine=comunica") ? "comunica" : "wazoo"
const REPEATS = 5
const QUERY_TIMEOUT_MS = 120_000
const DB_DIR = join(process.cwd(), "data", "providers", "worlds")
const OUT_DIR = join(process.cwd(), "data", "bench-artifacts", "conv26-perf")
const DB_NAMES = [
  "conv-26-q0-smoke-ds-001",
  "conv-26-q1-smoke-ds-001",
  "conv-26-q2-smoke-ds-001",
  "conv-26-q3-smoke-ds-001",
  "conv-26-q4-smoke-ds-001",
]

const PROV = "http://www.w3.org/ns/prov#"
const SCHEMA = "http://schema.org/"
const RDF = "http://www.w3.org/1999/02/22-rdf-syntax-ns#"
const WORLDS = "https://worlds.wazoo.dev/ns/memory#"

// The harness's query shapes. factClaimQuery/enrichmentQuery are the exact
// strings WorldsProvider issues (modulo the interpolated subject/URIs);
// countTypes/personEvents/ask are the agent-facing surfaces from
// scripts/verify-wazoo-engine.ts.
const QUERIES: Record<string, (ctx: { msgUris: string[] }) => string> = {
  ask: () => `PREFIX schema: <${SCHEMA}>\nASK { ?s a schema:Person }`,
  countTypes: () =>
    `SELECT ?type (COUNT(*) AS ?n) WHERE { ?s <${RDF}type> ?type } GROUP BY ?type ORDER BY DESC(?n) LIMIT 20`,
  personEvents: () =>
    `PREFIX schema: <${SCHEMA}>\nPREFIX rdf: <${RDF}>\nSELECT ?personName ?eventName ?status ?date WHERE {\n  ?e a schema:Event ; schema:name ?eventName ; schema:about ?p . ?p schema:name ?personName .\n  OPTIONAL { ?e schema:eventStatus ?status } OPTIONAL { ?e schema:startDate ?date }\n} LIMIT 5`,
  enrichment: ({ msgUris }) => {
    const valuesClause = msgUris.map((uri) => `<${uri}>`).join(" ")
    return `SELECT ?msg ?session ?date ?speaker ?speakerA ?speakerB WHERE {\n  VALUES ?msg { ${valuesClause} }\n  ?msg <${PROV}wasGeneratedBy> ?session .\n  ?session <${SCHEMA}dateCreated> ?date .\n  OPTIONAL { ?msg <${SCHEMA}creator> ?speaker }\n  OPTIONAL { ?session <${WORLDS}speakerA> ?speakerA }\n  OPTIONAL { ?session <${WORLDS}speakerB> ?speakerB }\n}`
  },
  factClaims: () =>
    `SELECT DISTINCT ?claim ?claimText ?type ?subj ?action ?obj ?when ?where ?session ?sessionDate WHERE {\n  ?claim <${PROV}wasDerivedFrom> ?session .\n  OPTIONAL { ?session <${SCHEMA}dateCreated> ?sessionDate }\n  { ?claim <${SCHEMA}text> ?claimText } UNION { ?claim <${WORLDS}claimText> ?claimText } .\n  OPTIONAL { ?claim <${RDF}type> ?type }\n  OPTIONAL {\n    ?claim <${SCHEMA}about> ?aboutNode .\n    OPTIONAL { ?aboutNode <${SCHEMA}name> ?subj }\n  }\n  OPTIONAL { ?claim <${WORLDS}claimSubject> ?subj }\n  OPTIONAL { ?claim <${WORLDS}claimAction> ?action }\n  OPTIONAL { ?claim <${WORLDS}claimObject> ?obj }\n  OPTIONAL { ?claim <${SCHEMA}startDate> ?when }\n  OPTIONAL { ?claim <${WORLDS}claimWhen> ?when }\n  OPTIONAL { ?claim <${SCHEMA}location> ?where }\n  OPTIONAL { ?claim <${WORLDS}claimWhere> ?where }\n  FILTER NOT EXISTS { ?claim <${WORLDS}status> <${WORLDS}Superseded> }\n  FILTER( CONTAINS(LCASE(STR(?subj)), "caroline") && true )\n}\nLIMIT 8`,
}
const QUERY_ORDER = ["ask", "countTypes", "personEvents", "enrichment", "factClaims"]

interface Normalized {
  kind: "select" | "ask" | "void"
  rows: Record<string, string>[]
  boolean?: boolean
}

function toRow(b: Record<string, { value: string | object }>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(b)) {
    if (v && typeof v.value === "string") out[k] = v.value
  }
  return out
}

/** Normalizes both the Wazoo tagged-union response and the Comunica adapter's
 * plain SparqlSelectResults/AskResults into one comparable shape. */
function normalize(res: unknown): Normalized {
  const r = res as
    | { kind?: string; data?: { results?: { bindings?: unknown[] }; boolean?: boolean } }
    | { results?: { bindings?: Record<string, { value: string | object }>[] }; boolean?: boolean }
  if (r && typeof r === "object" && "kind" in r && r.kind) {
    const tagged = r as {
      kind: string
      data: { results?: { bindings?: never[] }; boolean?: boolean }
    }
    if (tagged.kind === "select") {
      return { kind: "select", rows: (tagged.data?.results?.bindings ?? []).map(toRow) }
    }
    if (tagged.kind === "ask") return { kind: "ask", rows: [], boolean: tagged.data?.boolean }
    return { kind: "void", rows: [] }
  }
  const plain = r as {
    results?: { bindings?: Record<string, { value: string | object }>[] }
    boolean?: boolean
  }
  if (plain?.results?.bindings) {
    return { kind: "select", rows: plain.results.bindings.map(toRow) }
  }
  if (typeof plain?.boolean === "boolean") return { kind: "ask", rows: [], boolean: plain.boolean }
  return { kind: "void", rows: [] }
}

function fingerprint(rows: Record<string, string>[]): string {
  const sorted = rows.map((r) => JSON.stringify(r)).sort()
  return createHash("sha256").update(sorted.join("\n")).digest("hex").slice(0, 16)
}

function stats(times: number[]) {
  const sorted = [...times].sort((a, b) => a - b)
  const avg = times.reduce((a, b) => a + b, 0) / times.length
  return {
    n: times.length,
    avgMs: Math.round(avg * 100) / 100,
    minMs: Math.round(sorted[0]! * 100) / 100,
    maxMs: Math.round(sorted[sorted.length - 1]! * 100) / 100,
    p50Ms: Math.round(sorted[Math.floor(sorted.length / 2)]! * 100) / 100,
  }
}

async function timed(query: () => Promise<Normalized>): Promise<{ ms: number; res: Normalized }> {
  const t0 = performance.now()
  const res = await Promise.race([
    query(),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`query exceeded ${QUERY_TIMEOUT_MS}ms`)), QUERY_TIMEOUT_MS)
    ),
  ])
  return { ms: performance.now() - t0, res }
}

interface EngineHandle {
  exec: (query: string) => Promise<unknown>
  close: () => void
}

async function openEngine(dbPath: string, dbName: string): Promise<EngineHandle> {
  if (ENGINE === "wazoo") {
    const { createSqliteWorldsSdk } = await import("@worlds/sqlite")
    const db = new Database(dbPath)
    const client = await createSqliteWorldsSdk({ path: dbPath, db })
    return { exec: (q) => client.sparql({ query: q }), close: () => client.close() }
  }
  // Comunica baseline: the pre-#33 WorldsProvider wiring —
  // ComunicaSparqlEngine over the hexastore-backed LibsqlStore
  // (@worlds/client/adapters/comunica, traqula 1.2.0 override).
  const { WorldsProvider } = await import("../src/providers/worlds")
  const provider = new WorldsProvider()
  await provider.initialize({ apiKey: process.env.DEEPSEEK_API_KEY ?? "" })
  const client = await provider.getClientForContainer(dbName.replace(/\.db$/, ""))
  return { exec: (q) => client.sparql({ query: q }), close: () => {} }
}

async function main(): Promise<void> {
  console.log(`Engine: ${ENGINE} | repeats: ${REPEATS} | DBs: ${DB_NAMES.length}`)
  const records: Array<{
    db: string
    query: string
    kind: string
    rows: number
    fingerprint: string
    semanticFp: string
    semanticRows: number
    timings: ReturnType<typeof stats>
  }> = []

  for (const dbName of DB_NAMES) {
    const dbPath = join(DB_DIR, `${dbName}.db`)
    const engine = await openEngine(dbPath, dbName)
    console.log(`\n=== ${dbName} ===`)

    // Untimed helper: the enrichment query's VALUES clause is built from the
    // message URIs actually in the DB (the harness gets them from search
    // results). ORDER BY makes the 10-URI sample deterministic so both trees
    // benchmark the identical VALUES clause.
    const msgRes = normalize(
      await engine.exec(
        `SELECT ?msg WHERE { ?msg <${PROV}wasGeneratedBy> ?s } ORDER BY ?msg LIMIT 10`
      )
    )
    const msgUris = msgRes.rows.map((r) => r.msg!)

    for (const name of QUERY_ORDER) {
      const query = QUERIES[name]!({ msgUris })
      try {
        // Warmup (also captures the result fingerprint; ASK legitimately yields 0 rows).
        const warm = await timed(() => engine.exec(query).then(normalize))
        const times: number[] = []
        let res = warm.res
        for (let i = 0; i < REPEATS; i++) {
          const t = await timed(() => engine.exec(query).then(normalize))
          times.push(t.ms)
          res = t.res
        }
        const fp = fingerprint(res.rows)
        // Semantic equivalence check (untimed): for unordered+LIMIT queries
        // the LIMIT truncation is engine-order-dependent, so also fingerprint
        // the FULL solution set (LIMIT 1000, order-insensitive) — engines must
        // agree there even when their top-k differs.
        let semanticFp = fp
        let semanticRows = res.rows.length
        if (name === "personEvents" || name === "factClaims") {
          const full = normalize(
            await engine.exec(`${query.replace(/\bLIMIT\s+\d+\s*$/i, "LIMIT 1000")}`)
          )
          semanticFp = fingerprint(full.rows)
          semanticRows = full.rows.length
        }
        records.push({
          db: dbName,
          query: name,
          kind: res.kind,
          rows: res.rows.length,
          fingerprint: fp,
          semanticFp,
          semanticRows,
          timings: stats(times),
        })
        console.log(
          `  ${name.padEnd(12)} ${res.kind.padEnd(6)} rows=${String(res.rows.length).padEnd(4)} avg=${stats(times).avgMs.toFixed(1)}ms min=${stats(times).minMs.toFixed(1)}ms max=${stats(times).maxMs.toFixed(1)}ms fp=${fp}${semanticRows !== res.rows.length ? ` sem=${semanticRows}#${semanticFp}` : ""}`
        )
      } catch (err) {
        records.push({
          db: dbName,
          query: name,
          kind: "error",
          rows: 0,
          fingerprint: "",
          semanticFp: "",
          semanticRows: 0,
          timings: { n: 0, avgMs: 0, minMs: 0, maxMs: 0, p50Ms: 0 },
        })
        console.log(
          `  ${name.padEnd(12)} ERROR: ${err instanceof Error ? err.message : String(err)}`
        )
      }
    }
    engine.close()
  }

  await mkdir(OUT_DIR, { recursive: true })
  const artifact = {
    engine: ENGINE,
    repeats: REPEATS,
    bun: Bun.version,
    platform: `${process.platform}-${process.arch}`,
    cpus: navigator.hardwareConcurrency,
    startedAt: new Date().toISOString(),
    records,
  }
  const outPath = join(OUT_DIR, `results-${ENGINE}.json`)
  await writeFile(outPath, JSON.stringify(artifact, null, 2))
  console.log(`\nWrote ${outPath}`)

  // Cross-DB aggregate per query.
  console.log(`\n=== ${ENGINE} aggregate (avg of per-DB averages) ===`)
  for (const name of QUERY_ORDER) {
    const rows = records.filter((r) => r.query === name && r.kind !== "error")
    const errs = records.filter((r) => r.query === name && r.kind === "error").length
    const avg = rows.reduce((a, r) => a + r.timings.avgMs, 0) / (rows.length || 1)
    console.log(
      `  ${name.padEnd(12)} avg=${avg.toFixed(1)}ms over ${rows.length} DBs${errs ? ` (${errs} DB(s) errored)` : ""}`
    )
  }
}

main().catch((err) => {
  console.error("BENCH FAILED:", err)
  process.exit(1)
})
