import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { Database } from "bun:sqlite"
import type { WorldsSdkInterface } from "@worlds/sdk"
import type { SparqlRequest, SparqlResponse } from "@worlds/sdk/sparql-engine"
import { createSqliteWorldsSdk, type SqliteWorldsSdk } from "@worlds/sqlite"
import { PROV, RDF, SCHEMA, SPARQL_PREFIXES, WORLDS } from "./ontology"

/**
 * Durable SQLite SPARQL validation for the #25 engine swap (Comunica →
 * WazooSparqlEngine).
 *
 * `createSqliteWorldsSdk` wires the in-house WazooSparqlEngine over its
 * bun:sqlite-backed SqliteStore — the same path WorldsProvider.getClient
 * uses for its file-backed durable databases. These tests exercise the
 * harness's real query surface over that durable store so the engine swap
 * is gated on behavior, not just types:
 *
 * - SELECT shape (head.vars + results.bindings) — the enrichment VALUES
 *   query and the fact-claim FILTER/CONTAINS/UNION/OPTIONAL query.
 * - ASK (`kind: "ask"` + `data.boolean`) and void (UPDATE) kinds.
 * - COUNT/GROUP BY schema discovery, multi-hop joins, LIMIT.
 * - `baseIri` resolution of relative IRIs and request cancellation
 *   plumbing (pre-aborted `signal` rejects).
 *
 * Two documented behaviors surfaced by this suite (see the tests below):
 * ORDER BY over an aggregate alias reorders as of @worlds/sqlite 0.7.1
 * (sparql-engine#203 closing #201 — asserted positively in the
 * COUNT/GROUP BY test), and `timeoutMs` cannot preempt CPU-bound evaluation because the
 * timeout timer needs a macrotask tick while evaluation over the synchronous
 * SQLite store only yields microtasks (64s pathological join resolved past
 * timeoutMs=25; wazootech/sparql-engine#202).
 *
 * Search is disabled and no embedding service is configured: this suite
 * proves the SPARQL surface, not the FTS/vector stack.
 */

const SPARQL_NS = "https://worlds.wazoo.dev/ns/memory#"

const FIXTURE_TURTLE = `
@prefix schema: <http://schema.org/> .
@prefix prov: <http://www.w3.org/ns/prov#> .
@prefix worlds: <${SPARQL_NS}> .
<urn:session:val-001> a schema:Conversation ;
  schema:dateCreated "2026-09-12" ;
  schema:hasPart <urn:session:val-001/msg/0> , <urn:session:val-001/msg/1> .
<urn:session:val-001/msg/0> a schema:Message ;
  schema:text "Melanie works as a nurse at Harborview Medical Center." ;
  schema:position "0" ;
  schema:creator "Melanie" ;
  prov:wasGeneratedBy <urn:session:val-001> .
<urn:session:val-001/msg/1> a schema:Message ;
  schema:text "When did Sam paint a sunrise?" ;
  schema:position "1" ;
  schema:creator "Sam" ;
  prov:wasGeneratedBy <urn:session:val-001> .
<urn:person:val-001/melanie> a schema:Person ; schema:name "Melanie" ;
  schema:worksFor <urn:org:val-001/harborview> .
<urn:org:val-001/harborview> a schema:Organization ; schema:name "Harborview Medical Center" .
<urn:person:val-001/sam> a schema:Person ; schema:name "Sam" .
<urn:event:val-001/sunrise> a schema:Event ;
  schema:name "sunrise painting" ;
  schema:about <urn:person:val-001/sam> ;
  schema:startDate "2023-06-10" ;
  schema:eventStatus schema:EventScheduled ;
  schema:location "Seattle" .
<urn:claim:val-001/claim-1> a worlds:FactClaim ;
  worlds:claimText "Melanie works as a nurse at Harborview Medical Center" ;
  schema:about <urn:person:val-001/melanie> ;
  worlds:claimSubject "Melanie" ;
  worlds:claimAction "works for" ;
  worlds:claimObject "Harborview Medical Center" ;
  prov:wasDerivedFrom <urn:session:val-001> .
<urn:claim:val-001/claim-2> a worlds:FactClaim ;
  worlds:claimText "Sam painted a sunrise in Seattle" ;
  schema:about <urn:person:val-001/sam> ;
  worlds:claimSubject "Sam" ;
  worlds:claimAction "painted" ;
  worlds:claimObject "sunrise" ;
  worlds:status worlds:Superseded ;
  prov:wasDerivedFrom <urn:session:val-001> .
`

/** Harness's enrichment query: VALUES + join + OPTIONALs (worlds/index.ts). */
function enrichmentQuery(msgUris: string[]): string {
  const valuesClause = msgUris.map((uri) => `<${uri}>`).join(" ")
  return `
    SELECT ?msg ?session ?date ?speaker ?speakerA ?speakerB WHERE {
      VALUES ?msg { ${valuesClause} }
      ?msg <${PROV.wasGeneratedBy}> ?session .
      ?session <${SCHEMA.dateCreated}> ?date .
      OPTIONAL { ?msg <${SCHEMA.creator}> ?speaker }
      OPTIONAL { ?session <${WORLDS.speakerA}> ?speakerA }
      OPTIONAL { ?session <${WORLDS.speakerB}> ?speakerB }
    }
  `
}

/**
 * Harness's fact-claim query: UNION + nested OPTIONALs + FILTER CONTAINS on
 * claimText and claimSubject/action/object (worlds/index.ts queryFactClaims).
 */
function factClaimQuery(subject: string): string {
  return `
    SELECT DISTINCT ?claim ?claimText ?type ?subj ?action ?obj ?when ?where ?session ?sessionDate WHERE {
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
      FILTER( CONTAINS(LCASE(STR(?subj)), "${subject}") && true )
    }
    LIMIT 8
  `.trim()
}

/** Harness's schema-discovery query: COUNT/GROUP BY/ORDER BY/LIMIT. */
const COUNT_TYPES = `
  SELECT ?type (COUNT(*) AS ?n) WHERE { ?s <${RDF.type}> ?type } GROUP BY ?type ORDER BY DESC(?n) LIMIT 20
`.trim()

/** Agent-style multi-hop join: Event → Person with OPTIONALs (personEvents). */
const PERSON_EVENTS = `
  PREFIX schema: <http://schema.org/>
  SELECT ?personName ?eventName ?status ?date WHERE {
    ?e a schema:Event ; schema:name ?eventName ; schema:about ?p . ?p schema:name ?personName .
    OPTIONAL { ?e schema:eventStatus ?status } OPTIONAL { ?e schema:startDate ?date }
  } LIMIT 5
`.trim()

const ASK_PERSON = `
  PREFIX schema: <http://schema.org/>
  ASK { ?s a schema:Person }
`.trim()

describe("WazooSparqlEngine over durable SQLite (issue #25)", () => {
  let db: Database
  let client: SqliteWorldsSdk

  beforeAll(async () => {
    db = new Database(":memory:")
    client = await createSqliteWorldsSdk({
      path: ":memory:",
      db,
      searchIndexOnImport: "disabled",
    })
    await client.import({
      source: { kind: "serialized", data: FIXTURE_TURTLE, contentType: "text/turtle" },
    })
  })

  afterAll(() => {
    client.close()
    db.close()
  })

  it("returns kind=select with head.vars + results.bindings for the enrichment VALUES query", async () => {
    const response = await client.sparql({
      query: enrichmentQuery(["urn:session:val-001/msg/0", "urn:session:val-001/msg/1"]),
    })
    expect(response.kind).toBe("select")
    if (response.kind !== "select") return
    expect(response.data.head.vars).toEqual([
      "msg",
      "session",
      "date",
      "speaker",
      "speakerA",
      "speakerB",
    ])
    expect(response.data.results.bindings.length).toBe(2)
    for (const binding of response.data.results.bindings) {
      expect(binding.session?.value).toBe("urn:session:val-001")
      expect(binding.date?.value).toBe("2026-09-12")
      // schema:creator is stored as a plain literal in the fixture (and by
      // the harness's Turtle serializer); the enrichment str() helper only
      // reads .value, so term type is irrelevant to the contract.
      expect(binding.speaker?.value).toBeOneOf(["Melanie", "Sam"])
      // Unbound OPTIONAL: variable present in head.vars but absent from bindings.
      expect(binding.speakerA?.value).toBeUndefined()
    }
  })

  it("runs the fact-claim query with FILTER CONTAINS, UNION, OPTIONAL, and NOT EXISTS", async () => {
    const response = await client.sparql({ query: factClaimQuery("melanie") })
    expect(response.kind).toBe("select")
    if (response.kind !== "select") return
    expect(response.data.head.vars).toContain("claim")
    expect(response.data.head.vars).toContain("claimText")
    expect(response.data.results.bindings).toHaveLength(1)
    const [binding] = response.data.results.bindings
    expect(binding?.claimText?.value).toBe("Melanie works as a nurse at Harborview Medical Center")
    expect(binding?.subj?.value).toBe("Melanie")
    expect(binding?.action?.value).toBe("works for")
    expect(binding?.obj?.value).toBe("Harborview Medical Center")
    expect(binding?.type?.value).toBe(`${SPARQL_NS}FactClaim`)
    expect(binding?.session?.value).toBe("urn:session:val-001")
  })

  it("runs COUNT/GROUP BY schema discovery", async () => {
    const response = await client.sparql({ query: COUNT_TYPES })
    expect(response.kind).toBe("select")
    if (response.kind !== "select") return
    expect(response.data.head.vars).toEqual(["type", "n"])
    const byType = new Map(
      response.data.results.bindings.map((b) => [b.type?.value, Number(b.n?.value)])
    )
    expect(byType.get(`${SCHEMA._iri}Person`)).toBe(2)
    expect(byType.get(`${WORLDS.FactClaim}`)).toBe(2)
    expect(byType.get(`${SCHEMA._iri}Event`)).toBe(1)
    expect(byType.get(`${SCHEMA._iri}Organization`)).toBe(1)
    // Aggregate values are correct xsd:integer literals.
    for (const b of response.data.results.bindings) {
      const n = b.n
      if (n?.type !== "literal") throw new Error(`expected literal count, got ${n?.type}`)
      expect(n.datatype).toBe("http://www.w3.org/2001/XMLSchema#integer")
    }
    // ORDER BY over an aggregate alias reorders as of @worlds/sqlite 0.7.1
    // (engine 0.4.2, wazootech/sparql-engine#203 closing #201): the
    // schema-discovery query returns rows in descending count order.
    const counts = [...byType.values()]
    expect(counts).toEqual([...counts].sort((a, b) => b - a))
  })

  it("runs the multi-hop Event→Person join with OPTIONAL status/date", async () => {
    const response = await client.sparql({ query: PERSON_EVENTS })
    expect(response.kind).toBe("select")
    if (response.kind !== "select") return
    expect(response.data.results.bindings.length).toBeGreaterThan(0)
    const [binding] = response.data.results.bindings
    expect(binding?.personName?.value).toBe("Sam")
    expect(binding?.eventName?.value).toBe("sunrise painting")
    expect(binding?.status?.value).toBe(`${SCHEMA._iri}EventScheduled`)
    expect(binding?.date?.value).toBe("2023-06-10")
  })

  it("returns kind=ask with data.boolean for ASK", async () => {
    const response = await client.sparql({ query: ASK_PERSON })
    expect(response.kind).toBe("ask")
    if (response.kind !== "ask") return
    expect(response.data.boolean).toBe(true)
  })

  it("honors baseIri by resolving relative IRIs in the query", async () => {
    // #25 checklist item: the adapter's baseIri contract holds through the
    // SDK client (which forwards the full SparqlRequest to the engine).
    const response = await client.sparql({
      query: `SELECT ?s WHERE { ?s a <Person> }`,
      baseIri: "http://schema.org/",
    })
    expect(response.kind).toBe("select")
    if (response.kind !== "select") return
    const subjects = response.data.results.bindings.map((b) => b.s?.value).sort()
    expect(subjects).toEqual(["urn:person:val-001/melanie", "urn:person:val-001/sam"])
  })

  it("returns kind=void for an UPDATE through the durable transaction", async () => {
    const insert = `
      PREFIX schema: <http://schema.org/>
      INSERT DATA { <urn:person:val-001/kim> a schema:Person ; schema:name "Kim" }`
    const updateResponse = await client.sparql({ query: insert })
    expect(updateResponse.kind).toBe("void")

    const askResponse = await client.sparql({ query: ASK_PERSON })
    expect(askResponse.kind).toBe("ask")
    if (askResponse.kind !== "ask") return
    expect(askResponse.data.boolean).toBe(true)
  })

  it("rejects a request whose caller signal is already aborted", async () => {
    // The deterministic half of the cancellation contract (issue #122
    // plumbing): the engine composes the caller signal with its timeout
    // controller and rejects with the signal's reason.
    await expect(
      client.sparql({
        query: `SELECT ?s WHERE { ?s <${SCHEMA.name}> ?o }`,
        signal: AbortSignal.abort(new Error("caller abort")),
      })
    ).rejects.toThrow("caller abort")
  })

  it("documents that timeoutMs cannot preempt CPU-bound evaluation", async () => {
    // Divergence found while validating #25 (see the suite docblock):
    // WazooSparqlEngine enforces timeoutMs via an AbortController whose
    // timer callback needs a macrotask tick, but evaluation over the
    // synchronous SQLite store only yields microtasks — a 3.375M-row join
    // on this fixture shape resolved in 64s with timeoutMs=25 instead of
    // rejecting. The harness's real queries all terminate in <100ms so
    // this cannot hang a run, but a runaway agent-authored join is bounded
    // only by query complexity, not the timeout. Tracked upstream in
    // wazootech/sparql-engine#202; assert only that timeoutMs is accepted
    // without breaking a fast query.
    const response = await client.sparql({
      query: `SELECT ?name WHERE { ?s <${SCHEMA.name}> ?name } LIMIT 1`,
      timeoutMs: 25,
    })
    expect(response.kind).toBe("select")
  })

  it("keeps the shared durable db handle observable from raw SQL", async () => {
    const row = db.query("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table'").get() as {
      n: number
    }
    expect(row.n).toBeGreaterThan(0)
  })

  it("preserves the enrichment contract through the typed SparqlResponse union", async () => {
    const request: SparqlRequest = { query: enrichmentQuery(["urn:session:val-001/msg/0"]) }
    const response: SparqlResponse = await client.sparql(request)
    if (response.kind !== "select") throw new Error(`expected select, got ${response.kind}`)
    const [binding] = response.data.results.bindings
    expect(binding?.speaker?.value).toBe("Melanie")
  })

  it("runs the harness prefix surface end to end through WorldsSdkInterface", async () => {
    // WorldsSdkInterface.sparql is the exact surface the harness's
    // enrichSearchResults / queryFactClaims / agent worlds_sparql tool use.
    const providerLike: Pick<WorldsSdkInterface, "sparql"> = client
    const response = await providerLike.sparql({
      query: `${SPARQL_PREFIXES}
        SELECT ?claim ?claimText WHERE {
          ?claim a worlds:FactClaim ; worlds:claimText ?claimText .
          FILTER( CONTAINS(LCASE(?claimText), "melanie") )
        }`,
    })
    expect(response.kind).toBe("select")
    if (response.kind !== "select") return
    expect(response.data.results.bindings).toHaveLength(1)
    expect(response.data.results.bindings[0]?.claimText?.value).toBe(
      "Melanie works as a nurse at Harborview Medical Center"
    )
  })
})
