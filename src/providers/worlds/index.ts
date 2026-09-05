import { mkdir, rm } from "node:fs/promises"
import { join } from "node:path"
import { Database } from "bun:sqlite"
import type { WorldsSdkInterface } from "@worlds/sdk"
import { createSqliteWorldsSdk } from "@worlds/sqlite"
import type {
  IndexingProgressCallback,
  IngestOptions,
  IngestResult,
  Provider,
  ProviderConfig,
  SearchOptions,
} from "../../types/provider"
import type { UnifiedSession } from "../../types/unified"
import { logger } from "../../utils/logger"
import { WORLDS_PROMPTS } from "./prompts"
import { PROV, RDF, SCHEMA, TURTLE_PREFIXES, WORLDS, XSD } from "./ontology"
import { validateGraph } from "./shapes"
import { GEMINI_EMBEDDING_DIMENSIONS, GeminiEmbeddingService } from "./gemini-embedding-service"
import { OpenAIEmbeddingService } from "./openai-embedding-service"
import { CachedEmbeddingService } from "./cached-embedding-service"
import { extractFactsToTurtle } from "./extraction"
import { dedupeRankedById, sortRankedByScore } from "./search-contract"

/**
 * WorldsProvider implements the Provider interface for @worlds/sdk.
 *
 * @worlds/sdk is a graph-backed memory store with RDF import, semantic
 * search, and SPARQL query capabilities. This provider uses file-backed
 * SQLite databases (bun:sqlite) so completed ingest/index phases can be
 * reused when a run is resumed.
 */

export class WorldsProvider implements Provider {
  name = "worlds"
  prompts = WORLDS_PROMPTS
  concurrency = {
    default: 10,
    ingest: 2,
    indexing: 2,
  }

  private clients = new Map<string, WorldsSdkInterface>()
  private documentIds = new Map<string, string[]>()
  private baseDir = join(process.cwd(), "data", "providers", "worlds")
  private apiKey = ""

  async initialize(config: ProviderConfig): Promise<void> {
    this.apiKey = config.apiKey
    await mkdir(this.baseDir, { recursive: true })
    this.clients.clear()
    this.documentIds.clear()
    logger.info(
      `Initialized Worlds provider with file-backed SQLite (bun:sqlite) at ${this.baseDir}`
    )
  }

  /** Exposed for agent tool-calling scripts that need direct SPARQL access. */
  async getClientForContainer(containerTag: string): Promise<WorldsSdkInterface> {
    return this.getClient(containerTag)
  }

  private async getClient(containerTag: string): Promise<WorldsSdkInterface> {
    const existing = this.clients.get(containerTag)
    if (existing) return existing

    await mkdir(this.baseDir, { recursive: true })
    const dbPath = join(this.baseDir, `${sanitizePath(containerTag)}.db`)
    const db = new Database(dbPath)

    const useOpenAIOrOllama =
      Boolean(process.env.OPENAI_BASE_URL) ||
      process.env.EMBEDDING_PROVIDER === "ollama" ||
      process.env.EMBEDDING_PROVIDER === "openai" ||
      !this.apiKey

    const embeddingService = useOpenAIOrOllama
      ? new OpenAIEmbeddingService()
      : this.apiKey
        ? new GeminiEmbeddingService(this.apiKey)
        : undefined

    // Wrap with a shared content-addressed cache (data/cache/embeddings/,
    // per #18/#22) so fresh runs re-embed nothing. Label is provider/model
    // qualified so a model swap misses instead of poisoning, and scoped to
    // the resolved embedding endpoint so the same provider/model behind a
    // different base URL (local Ollama vs remote OpenAI-compatible) misses
    // instead of reusing stale vectors. Gemini's endpoint is fixed, so no
    // scope is needed for it.
    const embeddingProvider =
      process.env.EMBEDDING_PROVIDER ||
      (process.env.OPENAI_BASE_URL ? "openai" : !this.apiKey ? "ollama" : "gemini")
    const embeddingModel =
      embeddingProvider === "gemini"
        ? "gemini-embedding-2"
        : process.env.EMBEDDING_MODEL || "nomic-embed-text"
    const embeddingScope =
      embeddingProvider === "gemini"
        ? undefined
        : process.env.EMBEDDING_BASE_URL ||
          process.env.OPENAI_BASE_URL ||
          "http://localhost:11434/v1"
    const cachedEmbeddingService = embeddingService
      ? new CachedEmbeddingService(
          embeddingService,
          `${embeddingProvider}/${embeddingModel}`,
          embeddingScope
        )
      : undefined

    // createSqliteWorldsSdk wires the in-house WazooSparqlEngine over the
    // bun:sqlite-backed SqliteStore (the Comunica/traqula closure silently
    // broke every query in #23; the Wazoo engine is W3C-gated 345/345
    // SPARQL 1.1, 249/249 SPARQL 1.2, 41/41 RDF 1.2 triple terms — see
    // #25). The db handle is the developer-supplied bun:sqlite Database;
    // the SDK owns it and close() releases it.
    const client = await createSqliteWorldsSdk({
      path: dbPath,
      db,
      embeddingService: cachedEmbeddingService,
      vectorDimensions: embeddingService ? 768 : undefined,
      searchIndexOnImport: "disabled",
    })
    this.clients.set(containerTag, client)
    return client
  }

  async ingest(sessions: UnifiedSession[], options: IngestOptions): Promise<IngestResult> {
    const client = await this.getClient(options.containerTag)
    const ids = this.documentIds.get(options.containerTag) ?? []

    for (const session of sessions) {
      const turtle = this.formatSessionForIngestion(session)

      await client.import({
        source: {
          kind: "serialized",
          data: turtle,
          contentType: "text/turtle",
        },
      })

      // Shared content-addressed extraction cache (per #18/#22): NOT nested
      // under containerTag, so it survives fresh run IDs. extraction.ts
      // appends provider/model to the path for model-qualified keys.
      const cacheDir = join(process.cwd(), "data", "cache", "extraction")
      if (process.env.EXTRACTION_PROVIDER !== "none") {
        try {
          const extractionProvider =
            (process.env.EXTRACTION_PROVIDER as "gemini" | "ollama" | "openai" | "deepseek") ||
            (process.env.OPENAI_BASE_URL ? "ollama" : "gemini")
          const factsTurtle = await extractFactsToTurtle(this.apiKey, session, {
            cacheDir,
            provider: extractionProvider,
          })
          if (factsTurtle) {
            await client.import({
              source: {
                kind: "serialized",
                data: factsTurtle,
                contentType: "text/turtle",
              },
            })
            logger.debug(`Imported extracted facts for session ${session.sessionId}`)
          }
        } catch (err) {
          logger.warn(`Fact extraction failed for ${session.sessionId}, continuing: ${err}`)
        }
      }

      ids.push(session.sessionId)
      logger.debug(`Ingested session ${session.sessionId} with ${session.messages.length} messages`)
    }

    this.documentIds.set(options.containerTag, ids)
    return { documentIds: sessions.map((session) => session.sessionId) }
  }

  private formatSessionForIngestion(session: UnifiedSession): string {
    const { sessionId, messages, metadata } = session
    const sessionUri = `urn:session:${sessionId}`

    const date = (metadata?.formattedDate as string) || (metadata?.date as string) || "unknown"

    const lines: string[] = [TURTLE_PREFIXES, ""]

    const speakerA = metadata?.speakerA as string | undefined
    const speakerB = metadata?.speakerB as string | undefined

    // Session node: schema:Conversation + prov:Activity
    lines.push(
      `<${sessionUri}> <${RDF.type}> <${SCHEMA.Conversation}> .`,
      `<${sessionUri}> <${RDF.type}> <${PROV.Activity}> .`,
      `<${sessionUri}> <${SCHEMA.dateCreated}> "${date}" .`
    )
    if (speakerA) {
      lines.push(`<${sessionUri}> <${WORLDS.speakerA}> "${escapeTurtleLiteral(speakerA)}" .`)
    }
    if (speakerB) {
      lines.push(`<${sessionUri}> <${WORLDS.speakerB}> "${escapeTurtleLiteral(speakerB)}" .`)
    }

    // Message nodes with typed predicates and provenance
    for (let idx = 0; idx < messages.length; idx++) {
      const msg = messages[idx]
      const msgUri = `${sessionUri}/msg/${idx}`
      const escapedContent = escapeTurtleLiteral(msg.content as string)

      lines.push(
        "",
        `<${sessionUri}> <${SCHEMA.hasPart}> <${msgUri}> .`,
        `<${msgUri}> <${RDF.type}> <${SCHEMA.Message}> .`,
        `<${msgUri}> <${RDF.type}> <${PROV.Entity}> .`,
        `<${msgUri}> <${SCHEMA.text}> "${escapedContent}" .`,
        `<${msgUri}> <${SCHEMA.position}> "${idx}"^^<${XSD.integer}> .`,
        `<${msgUri}> <${SCHEMA.author}> "${msg.role}" .`,
        `<${msgUri}> <${PROV.wasGeneratedBy}> <${sessionUri}> .`
      )
      if (msg.speaker) {
        lines.push(`<${msgUri}> <${SCHEMA.creator}> "${escapeTurtleLiteral(msg.speaker)}" .`)
      }
    }

    const turtle = lines.join("\n")

    const validation = validateGraph(turtle)
    if (!validation.valid) {
      logger.warn(
        `SHACL validation warnings for session ${sessionId}: ${validation.errors.join("; ")}`
      )
    }

    return turtle
  }

  async awaitIndexing(
    result: IngestResult,
    containerTag: string,
    onProgress?: IndexingProgressCallback
  ): Promise<void> {
    const client = await this.getClient(containerTag)
    const indexResult = await client.reindex()
    logger.info(
      `Worlds: rebuilt search index for ${containerTag} — ` +
        `${indexResult.processedQuadCount} quads processed, ${indexResult.chunkRowCount} chunk rows`
    )
    onProgress?.({
      completedIds: result.documentIds,
      failedIds: [],
      total: result.documentIds.length,
    })
  }

  async search(query: string, options: SearchOptions): Promise<unknown[]> {
    const client = await this.getClient(options.containerTag)

    const [searchResults, factClaimsRaw] = await Promise.all([
      searchWithFallback(client, query).then((r) => enrichSearchResults(client, r)),
      queryFactClaims(client, query),
    ])

    // Ranked messages first (score = retrieval relevance only, contract D8),
    // then SPARQL fact claims as a downstream, unscored complement.
    const first10 = searchResults.slice(0, 10)
    const rest = searchResults.slice(10)
    const searchCorpus = first10.map((r) => (r.text ?? "").toLowerCase()).join("\n")

    const factClaims = factClaimsRaw.filter((f) => {
      const c = f.claimText.toLowerCase().trim()
      if (c.length < 20) return true
      return !searchCorpus.includes(c.slice(0, Math.min(80, c.length)))
    })

    return [...first10, ...factClaims, ...rest]
  }

  async clear(containerTag: string): Promise<void> {
    this.clients.delete(containerTag)
    this.documentIds.delete(containerTag)
    const dbPath = join(this.baseDir, `${sanitizePath(containerTag)}.db`)
    await rm(dbPath, { force: true })
    // Note: the shared data/cache/ (embeddings + extraction) is deliberately
    // untouched here — it is content-addressed and cross-run; reset it with
    // the `cache-clear` command.
    logger.info(`Cleared Worlds provider state for ${containerTag}`)
  }
}

type SearchResponse = Awaited<ReturnType<WorldsSdkInterface["search"]>>
type SearchResult = NonNullable<SearchResponse["results"]>[number]

interface EnrichedSearchResult {
  /** Deterministic search-result id (shared across backends via buildSearchResultId). */
  id: string
  /** Graph session URI the result belongs to (resolved via SPARQL enrichment). */
  sessionId: string
  text: string
  /** Null when the result is unranked (fallback mode). */
  score: number | null
  subject: string
  predicate: string
  graph: string
  sessionDate?: string
  speaker?: string
  speakerA?: string
  speakerB?: string
}

/**
 * Resolves session dates, speaker names, and participant metadata for each
 * search result via a single batched SPARQL SELECT query.
 */
async function enrichSearchResults(
  client: WorldsSdkInterface,
  results: SearchResult[]
): Promise<EnrichedSearchResult[]> {
  const base: EnrichedSearchResult[] = results.map((r) => ({
    id: r.id,
    // Best local proxy before enrichment: the message URI embeds the session
    // (`urn:session:<id>/msg/<idx>`). Enrichment replaces it with the real
    // session URI once the graph join resolves.
    sessionId: r.subject,
    text: r.text,
    score: r.score,
    subject: r.subject,
    predicate: r.predicate,
    graph: r.graph,
  }))

  if (base.length === 0) return base

  const msgUris = [...new Set(base.map((r) => r.subject))]
  const valuesClause = msgUris.map((uri) => `<${uri}>`).join(" ")

  const query = `
    SELECT ?msg ?session ?date ?speaker ?speakerA ?speakerB WHERE {
      VALUES ?msg { ${valuesClause} }
      ?msg <${PROV.wasGeneratedBy}> ?session .
      ?session <${SCHEMA.dateCreated}> ?date .
      OPTIONAL { ?msg <${SCHEMA.creator}> ?speaker }
      OPTIONAL { ?session <${WORLDS.speakerA}> ?speakerA }
      OPTIONAL { ?session <${WORLDS.speakerB}> ?speakerB }
    }
  `

  try {
    const response = await client.sparql({ query })

    if (response.kind !== "select") return base

    const metaMap = new Map<
      string,
      {
        session?: string
        date?: string
        speaker?: string
        speakerA?: string
        speakerB?: string
      }
    >()

    const str = (v?: { value: string | object }): string | undefined =>
      v && typeof v.value === "string" ? v.value : undefined

    for (const binding of response.data.results.bindings) {
      const msgUri = str(binding.msg)
      if (!msgUri) continue
      metaMap.set(msgUri, {
        session: str(binding.session),
        date: str(binding.date),
        speaker: str(binding.speaker),
        speakerA: str(binding.speakerA),
        speakerB: str(binding.speakerB),
      })
    }

    for (const r of base) {
      const meta = metaMap.get(r.subject)
      if (meta) {
        // The contract's `id` is a per-result deterministic id, not a session
        // reference — resolve the real session URI from the graph instead.
        if (meta.session) r.sessionId = meta.session
        r.sessionDate = meta.date
        r.speaker = meta.speaker
        r.speakerA = meta.speakerA
        r.speakerB = meta.speakerB
      }
    }

    logger.debug(`SPARQL enrichment: resolved metadata for ${metaMap.size}/${base.length} results`)
  } catch (err) {
    logger.warn(`SPARQL enrichment failed, returning unenriched results: ${err}`)
  }

  return base
}

interface FactClaimResult {
  isClaim: true
  claimText: string
  claimType: string
  subject: string
  action: string
  object: string
  when?: string
  where?: string
  sessionUri?: string
  sessionDate?: string
}

function escapeSparqlSubstring(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
}

/** Proper nouns / capitalized tokens (e.g. person names) for structured matching. */
function extractQueryEntities(query: string): string[] {
  const noise = new Set([
    "what",
    "when",
    "where",
    "who",
    "why",
    "which",
    "how",
    "the",
    "and",
    "but",
    "this",
    "that",
    "these",
    "those",
    "did",
    "does",
    "with",
    "from",
    "your",
    "you",
    "she",
    "her",
    "his",
    "for",
    "are",
    "was",
    "were",
    "has",
    "have",
    "had",
    "not",
    "any",
    "all",
    "can",
    "may",
    "will",
    "would",
    "could",
    "should",
  ])
  const seen = new Set<string>()
  for (const m of query.matchAll(/\b[A-Z][a-z]{2,}\b/g)) {
    const w = m[0].toLowerCase()
    if (!noise.has(w)) seen.add(w)
  }
  return [...seen]
}

function buildTextMatchClause(terms: string[], joiner: "&&" | "||"): string {
  if (terms.length === 0) return "true"
  const op = ` ${joiner} `
  return terms.map((t) => `CONTAINS(LCASE(?claimText), "${escapeSparqlSubstring(t)}")`).join(op)
}

function buildEntityMatchClause(entities: string[]): string {
  if (entities.length === 0) return "true"
  return entities
    .map((e) => {
      const x = escapeSparqlSubstring(e)
      return (
        `CONTAINS(LCASE(?claimText), "${x}") || CONTAINS(LCASE(STR(?subj)), "${x}") || ` +
        `CONTAINS(LCASE(STR(?action)), "${x}") || CONTAINS(LCASE(STR(?obj)), "${x}")`
      )
    })
    .join(" || ")
}

function parseFactBindings(response: unknown): FactClaimResult[] {
  if (
    typeof response !== "object" ||
    response === null ||
    (response as { kind?: string }).kind !== "select"
  ) {
    return []
  }
  const data = (
    response as {
      data: {
        results: { bindings: Record<string, { value: string | object }>[] }
      }
    }
  ).data
  if (!data?.results?.bindings) return []

  const str = (v?: { value: string | object }): string | undefined =>
    v && typeof v.value === "string" ? v.value : undefined

  const claims: FactClaimResult[] = []
  for (const binding of data.results.bindings) {
    const claimText = str(binding.claimText)
    if (!claimText) continue

    const typeUri = str(binding.type) || ""
    const claimType = typeUri.split("#").pop() || "Claim"

    claims.push({
      isClaim: true,
      claimText,
      claimType,
      subject: str(binding.subj) || "",
      action: str(binding.action) || "",
      object: str(binding.obj) || "",
      when: str(binding.when),
      where: str(binding.where),
      sessionUri: str(binding.session),
      sessionDate: str(binding.sessionDate),
    })
  }
  return claims
}

async function runFactClaimSparql(
  client: WorldsSdkInterface,
  textClause: string,
  entityClause: string,
  limit: number
): Promise<FactClaimResult[]> {
  const sparql =
    `SELECT DISTINCT ?claim ?claimText ?type ?subj ?action ?obj ?when ?where ?session ?sessionDate WHERE {
    ?claim <${PROV.wasDerivedFrom}> ?session .
    OPTIONAL { ?session <${SCHEMA.dateCreated}> ?sessionDate }
    { ?claim <${SCHEMA.text}> ?claimText } UNION { ?claim <${WORLDS.claimText}> ?claimText } .
    OPTIONAL { ?claim <${RDF.type}> ?type }
    OPTIONAL {
      ?claim <${SCHEMA.about}> ?aboutNode .
      OPTIONAL { ?aboutNode <${SCHEMA.name}> ?subj }
    }
    OPTIONAL { ?claim <${WORLDS.claimSubject}> ?subj }
    OPTIONAL { ?claim <${WORLDS.claimAction}> ?action }
    OPTIONAL { ?claim <${WORLDS.claimObject}> ?obj }
    OPTIONAL { ?claim <${SCHEMA.startDate}> ?when }
    OPTIONAL { ?claim <${WORLDS.claimWhen}> ?when }
    OPTIONAL { ?claim <${SCHEMA.location}> ?where }
    OPTIONAL { ?claim <${WORLDS.claimWhere}> ?where }
    FILTER NOT EXISTS { ?claim <${WORLDS.status}> <${WORLDS.Superseded}> }
    FILTER( ( ${entityClause} ) && ( ${textClause} ) )
  }
  LIMIT ${limit}`.trim()

  try {
    const response = await client.sparql({ query: sparql })
    return parseFactBindings(response)
  } catch (err) {
    logger.warn(`SPARQL fact claim query failed: ${err}`)
    return []
  }
}

/**
 * Queries extracted fact claims via SPARQL: entity-aware matching on
 * subject/action/object/claimText, AND-first on keywords for precision,
 * OR fallback for recall. LIMIT 8 for latency.
 *
 * Fact claims are a downstream complement to ranked search (contract D8):
 * they are merged AFTER ranking and carry no search score — relevance scoring
 * never applies here.
 */
async function queryFactClaims(
  client: WorldsSdkInterface,
  query: string
): Promise<FactClaimResult[]> {
  try {
    const terms = extractContentTerms(query)
    const entities = extractQueryEntities(query)
    if (terms.length === 0 && entities.length === 0) return []

    const entityClause = buildEntityMatchClause(entities)
    const limit = 8

    let claims: FactClaimResult[] = []

    if (terms.length > 0) {
      const textAnd = buildTextMatchClause(terms, "&&")
      claims = await runFactClaimSparql(client, textAnd, entityClause, limit)
      if (claims.length === 0 && terms.length > 1) {
        const textOr = buildTextMatchClause(terms, "||")
        claims = await runFactClaimSparql(client, textOr, entityClause, limit)
      }
    } else {
      claims = await runFactClaimSparql(client, "true", entityClause, limit)
    }

    if (claims.length > 0) {
      logger.debug(`SPARQL fact lookup: "${query.slice(0, 50)}…" → ${claims.length} claims`)
    }

    return claims
  } catch (err) {
    logger.warn(`SPARQL fact lookup failed: ${err}`)
    return []
  }
}

async function runSearch(client: WorldsSdkInterface, query: string): Promise<SearchResult[]> {
  const response = await client.search({ query })
  return response.results ?? []
}

/**
 * Try the full query first. FTS5 uses AND between terms after stopword
 * removal, so long natural-language questions often match nothing.
 * Fall back to per-term OR-style search and merge via best-score dedup on
 * the contract's deterministic `id` (worlds-api#30), re-ranked by score.
 *
 * Local SDK backends emit no `mode` signal and are treated as ranked. Scores
 * here are retrieval relevance only (contract D8) — never answer quality.
 */
async function searchWithFallback(
  client: WorldsSdkInterface,
  query: string
): Promise<SearchResult[]> {
  const results = await runSearch(client, query)
  if (results.length > 0) {
    logger.debug(`Worlds search: "${query.slice(0, 50)}…" → ${results.length} results`)
    return results
  }

  const terms = extractContentTerms(query)
  if (terms.length <= 1) return results

  const termResults: SearchResult[] = []
  for (const term of terms) {
    termResults.push(...(await runSearch(client, term)))
  }

  const merged = sortRankedByScore(dedupeRankedById(termResults)).slice(0, 100)
  logger.info(
    `Worlds search broadened: "${query.slice(
      0,
      50
    )}…" → ${terms.length} terms → ${merged.length} results`
  )
  return merged
}

const STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "been",
  "being",
  "but",
  "by",
  "did",
  "do",
  "does",
  "for",
  "from",
  "had",
  "has",
  "have",
  "how",
  "i",
  "if",
  "in",
  "into",
  "is",
  "it",
  "its",
  "me",
  "my",
  "not",
  "of",
  "on",
  "or",
  "our",
  "please",
  "that",
  "the",
  "their",
  "these",
  "those",
  "this",
  "to",
  "us",
  "was",
  "we",
  "were",
  "what",
  "when",
  "where",
  "which",
  "who",
  "why",
  "with",
  "you",
  "your",
])

function extractContentTerms(query: string): string[] {
  return query
    .split(/\s+/)
    .map((t) => t.toLowerCase().replace(/[^a-z0-9]/g, ""))
    .filter((t) => t.length > 1 && !STOPWORDS.has(t))
}

function sanitizePath(input: string): string {
  return input.replace(/[^a-zA-Z0-9_.-]/g, "_")
}

function escapeTurtleLiteral(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t")
}

export default WorldsProvider
