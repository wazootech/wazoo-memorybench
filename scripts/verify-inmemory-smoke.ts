import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { Database } from "bun:sqlite"
import { WorldsProvider } from "../src/providers/worlds/index"
import { createWorldsAgentTools } from "../src/providers/worlds/agent-tools"

class InMemoryWorldsProvider {
  name = "worlds-inmemory"
  prompts = { systemPrompt: "", toolDescriptions: {} } as const
  concurrency = { default: 10, ingest: 2, indexing: 2 }

  private clients = new Map<string, import("@worlds/sdk").WorldsSdkInterface>()
  private documentIds = new Map<string, string[]>()
  private apiKey = ""

  async initialize(config: { apiKey?: string }): Promise<void> {
    this.apiKey = config.apiKey ?? ""
  }

  async getClientForContainer(
    containerTag: string
  ): Promise<import("@worlds/sdk").WorldsSdkInterface> {
    const existing = this.clients.get(containerTag)
    if (existing) return existing

    const { createSqliteWorldsSdk } = await import("@worlds/sqlite")
    const client = await createSqliteWorldsSdk({
      path: ":memory:",
      db: new Database(":memory:"),
      embeddingService: undefined,
      vectorDimensions: undefined,
      searchIndexOnImport: "disabled",
    })
    this.clients.set(containerTag, client)
    return client
  }

  async ingest(
    sessions: Parameters<WorldsProvider["ingest"]>[0],
    options: Parameters<WorldsProvider["ingest"]>[1]
  ): Promise<ReturnType<WorldsProvider["ingest"]>> {
    const client = await this.getClientForContainer(options.containerTag)
    const ids = this.documentIds.get(options.containerTag) ?? []

    for (const session of sessions) {
      const sessionUri = `urn:session:${session.sessionId}`
      const date =
        (session.metadata?.formattedDate as string) ||
        (session.metadata?.date as string) ||
        "unknown"

      const lines = [
        `@prefix schema: <http://schema.org/> .`,
        `@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .`,
        `@prefix prov: <http://www.w3.org/ns/prov#> .`,
        `@prefix worlds: <https://worlds.wazoo.dev/ns/memory#> .`,
        `@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .`,
        "",
        `<${sessionUri}> rdf:type schema:Conversation .`,
        `<${sessionUri}> rdf:type prov:Activity .`,
        `<${sessionUri}> schema:dateCreated "${date}" .`,
      ]

      if (session.metadata?.speakerA) {
        lines.push(`<${sessionUri}> worlds:speakerA "${session.metadata.speakerA}" .`)
      }
      if (session.metadata?.speakerB) {
        lines.push(`<${sessionUri}> worlds:speakerB "${session.metadata.speakerB}" .`)
      }

      for (let idx = 0; idx < session.messages.length; idx++) {
        const msg = session.messages[idx]
        const msgUri = `${sessionUri}/msg/${idx}`
        const escaped = msg.content.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
        lines.push(
          "",
          `<${sessionUri}> schema:hasPart <${msgUri}> .`,
          `<${msgUri}> rdf:type schema:Message .`,
          `<${msgUri}> rdf:type prov:Entity .`,
          `<${msgUri}> schema:text "${escaped}" .`,
          `<${msgUri}> schema:position "${idx}"^^xsd:integer .`,
          `<${msgUri}> schema:author "${msg.role}" .`,
          `<${msgUri}> prov:wasGeneratedBy <${sessionUri}> .`
        )
        if (msg.speaker) {
          lines.push(`<${msgUri}> schema:creator "${msg.speaker}" .`)
        }
      }

      const turtle = lines.join("\n")

      await client.import({
        source: { kind: "serialized", data: turtle, contentType: "text/turtle" },
      })
      await client.import({
        source: { kind: "serialized", data: factsTurtle, contentType: "text/turtle" },
      })
      ids.push(session.sessionId)
    }

    this.documentIds.set(options.containerTag, ids)
    return { documentIds: sessions.map((s) => s.sessionId) }
  }

  async awaitIndexing(
    result: ReturnType<WorldsProvider["ingest"]>,
    containerTag: string
  ): Promise<void> {
    const client = await this.getClientForContainer(containerTag)
    await client.reindex()
  }

  async clear(containerTag: string): Promise<void> {
    this.clients.delete(containerTag)
    this.documentIds.delete(containerTag)
  }
}

const CONTAINER = "agent-tools-smoke-inmemory"
const FIXTURE = join(import.meta.dir, "..", "fixtures", "mini-extraction-session.json")
const FACTS = join(import.meta.dir, "..", "fixtures", "mini-extraction-facts.ttl")

const session = JSON.parse(await readFile(FIXTURE, "utf-8")) as {
  sessionId: string
  metadata?: Record<string, unknown>
  messages: { role: string; content: string; speaker?: string }[]
}

const factsTurtle = await readFile(FACTS, "utf-8")

console.log("=== In-memory agent-tools smoke verification ===")
console.log("Container: wazootech/sparql-engine MemoryStore (in-memory SQLite)")

const provider = new InMemoryWorldsProvider()
await provider.initialize({ apiKey: process.env.GEMINI_API_KEY ?? "" })
await provider.clear(CONTAINER)

const ingestStart = performance.now()
const ingestResult = await provider.ingest([session], { containerTag: CONTAINER })
console.log(
  `INGEST  ${Math.round(performance.now() - ingestStart)}ms | ${ingestResult.documentIds.length} session(s)`
)

await provider.awaitIndexing(ingestResult, CONTAINER)

const tools = await createWorldsAgentTools(provider as unknown as WorldsProvider, CONTAINER)
console.log(`TOOLS   ${Object.keys(tools).join(", ")}`)

const toolOptions = { toolCallId: "smoke", messages: [], context: {} } as never

// Mechanical phase
console.log("\n--- Mechanical phase ---")

const searchRes = (await tools.searchWorld.execute!({ query: "Melanie" }, toolOptions)) as {
  success: boolean
  data?: { results?: Array<{ text: string; score: number }> }
  error?: string
}
const searchHits = searchRes.data?.results ?? []
console.log(`SEARCH  success=${searchRes.success} | ${searchHits.length} hits`)

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
console.log(`SPARQL  success=${sparqlRes.success} | ${bindings.length} worksFor bindings`)
bindings.forEach((b) => console.log(`         ${b.person?.value} -> ${b.org?.value}`))

const schemaDiscoveryRes = (await tools.executeSparql.execute!(
  {
    query:
      "SELECT ?type ?predicate WHERE { ?subject a ?type ; ?predicate ?object } LIMIT 20",
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

const mechanicalPass =
  searchRes.success &&
  searchHits.length > 0 &&
  sparqlRes.success &&
  bindings.length > 0 &&
  schemaDiscoveryRes.success &&
  schemaBindings.length > 0

console.log("\n--- Verdict ---")
if (!mechanicalPass) {
  console.error("FAIL: Mechanical phase failed")
  process.exit(1)
}

console.log("PASS: Mechanical phase verified with in-memory store")
console.log("\nNote: Agentic phase requires valid DEEPSEEK_API_KEY")
console.log("      Run with a real key to verify the full agent loop")
