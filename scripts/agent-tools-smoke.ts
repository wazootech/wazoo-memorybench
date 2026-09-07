/**
 * End-to-end agent-tools proof (wazoo-tools PR #7 test-plan box 3).
 *
 * Proves an agent can query extracted graph data through wazoo-tools'
 * createTools wired onto WorldsProvider.getClientForContainer:
 *
 *   1. ingest the mini fixture session (extraction via content-addressed
 *      cache — a repeat run costs zero LLM tokens)
 *   2. build the tool surface via createWorldsAgentTools
 *   3. MECHANICAL: call searchWorld / executeSparql / discoverSchema execute()
 *      exactly as an agent runtime would, assert graph-derived answers
 *   4. AGENTIC: a real DeepSeek generateText loop with the tools — the model
 *      must pick tools itself and answer from the graph
 *
 *   DEEPSEEK_API_KEY=sk-... EXTRACTION_PROVIDER=deepseek \
 *     bun run scripts/agent-tools-smoke.ts
 *
 * Use --skip-agent to run only the mechanical phase (fully cache-warm, $0).
 */
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { generateText, stepCountIs } from "ai"
import { createOpenAI } from "@ai-sdk/openai"
import { WorldsProvider } from "../src/providers/worlds/index"
import { createWorldsAgentTools } from "../src/providers/worlds/agent-tools"

function arg(name: string): boolean {
  return process.argv.includes(`--${name}`)
}

const key = process.env.DEEPSEEK_API_KEY
if (!key) {
  console.error("Missing DEEPSEEK_API_KEY (needed for the extraction cache key and the agent loop)")
  process.exit(1)
}

const CONTAINER = "agent-tools-smoke"
const FIXTURE = join(import.meta.dir, "..", "fixtures", "mini-extraction-session.json")
const skipAgent = arg("skip-agent")

const session = JSON.parse(await readFile(FIXTURE, "utf-8")) as {
  sessionId: string
  metadata?: Record<string, unknown>
  messages: { role: string; content: string; speaker?: string }[]
}

// ---- 1. Provider + ingest (extraction is a cache hit on repeat runs) ----
const provider = new WorldsProvider()
await provider.initialize({ apiKey: process.env.GEMINI_API_KEY ?? "" })
await provider.clear(CONTAINER)

const ingestStart = performance.now()
const ingestResult = await provider.ingest([session], { containerTag: CONTAINER })
const ingestMs = performance.now() - ingestStart
console.log(
  `INGEST  ${ingestMs.toFixed(0)} ms | session ${session.sessionId} | ${JSON.stringify(ingestResult ?? "")}`
)

await provider.awaitIndexing(ingestResult, CONTAINER)

const tools = await createWorldsAgentTools(provider, CONTAINER)
console.log(`TOOLS   ${Object.keys(tools).join(", ")}`)

const toolOptions = { toolCallId: "smoke", messages: [], context: {} } as never

// ---- 2. Mechanical phase: the exact surface an agent runtime calls ----
console.log("─".repeat(64))

const searchRes = (await tools.searchWorld.execute!({ query: "Melanie" }, toolOptions)) as {
  success: boolean
  data?: { results?: Array<{ text: string; score: number }> }
  error?: string
}
const searchHits = searchRes.data?.results ?? []
console.log(
  `SEARCH  success=${searchRes.success} | ${searchHits.length} hits | top: ${JSON.stringify(searchHits[0]?.text?.slice(0, 80))}`
)

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

const schemaRes = (await tools.discoverSchema.execute!({}, toolOptions)) as {
  success: boolean
  data?: unknown
  error?: string
}
const schemaStr = JSON.stringify(schemaRes.data ?? {})
console.log(`SCHEMA  success=${schemaRes.success} | ${schemaStr.length} chars of ontology surface`)

let mechanicalPass =
  searchRes.success &&
  searchHits.length > 0 &&
  sparqlRes.success &&
  bindings.length > 0 &&
  schemaRes.success

// ---- 3. Agentic phase: real DeepSeek loop with the tools ----
let agentPass = false
let agentAnswer = ""
if (!skipAgent) {
  console.log("─".repeat(64))
  const deepseek = createOpenAI({
    baseURL: "https://api.deepseek.com",
    apiKey: key,
    compatibility: "compatible",
  })
  const t0 = performance.now()
  const result = await generateText({
    model: deepseek("deepseek-chat"),
    system:
      "You answer questions strictly from a knowledge graph using the provided tools. Always use tools before answering.",
    prompt:
      "Who works at which organization according to the graph? Use the tools to find the person and their employer, then answer with both names.",
    tools,
    stopWhen: stepCountIs(6),
  })
  const agentMs = performance.now() - t0
  agentAnswer = result.text
  const toolNames = result.steps.flatMap((s) => s.toolCalls.map((c) => c.toolName))
  console.log(
    `AGENT   ${agentMs.toFixed(0)} ms | ${result.steps.length} steps | tools used: ${[...new Set(toolNames)].join(", ") || "(none)"}`
  )
  console.log(`AGENT   answer: ${agentAnswer.slice(0, 200)}`)
  agentPass =
    toolNames.length > 0 && /melanie/i.test(agentAnswer) && /harborview/i.test(agentAnswer)
}

// ---- Verdict ----
console.log("─".repeat(64))
if (!mechanicalPass) {
  console.error("AGENT-TOOLS SMOKE FAILED (mechanical phase)")
  if (!searchRes.success) console.error(`  search error: ${searchRes.error}`)
  if (!sparqlRes.success) console.error(`  sparql error: ${sparqlRes.error}`)
  if (!schemaRes.success) console.error(`  schema error: ${schemaRes.error}`)
  process.exit(1)
}
if (!skipAgent && !agentPass) {
  console.error(
    "AGENT-TOOLS SMOKE FAILED (agentic phase: no tool use or answer missing person/org)"
  )
  process.exit(1)
}
console.log(
  skipAgent
    ? "AGENT-TOOLS SMOKE PASS — mechanical phase only"
    : "AGENT-TOOLS SMOKE PASS — agent queried extracted graph data end-to-end"
)
