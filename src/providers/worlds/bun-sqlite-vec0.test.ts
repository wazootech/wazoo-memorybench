import { beforeAll, afterAll, describe, expect, it, spyOn } from "bun:test"
import { Database } from "bun:sqlite"
import type { EmbeddingService } from "@worlds/sdk"
import { createSqliteWorldsSdk, type SqliteWorldsSdk } from "@worlds/sqlite"

/**
 * vec0-on-bun:sqlite leg (Windows CI) — regression guard for the #46 swap
 * (PR #47). @worlds/sqlite@0.7.0 accepts a developer-supplied bun:sqlite
 * Database via the AnySyncSqliteHandle seam (worlds-sqlite#24/#25), and the
 * open question was whether sqlite-vec's platform prebuilt (vec0.dll on
 * Windows) actually loads through bun:sqlite's loadExtension — and whether
 * hybrid search then returns rows. This test pins that behavior wherever it
 * runs, constructing the SDK exactly like WorldsProvider.getClient does
 * (bun:sqlite Database, 768-dim embedding service, searchIndexOnImport
 * "disabled"), with deterministic offline embeddings so no network or
 * ollama is needed.
 */

const VECTOR_DIMENSIONS = 768

/** Deterministic offline embedder mirroring the provider's 768-dim wiring. */
class DeterministicEmbeddingService implements EmbeddingService {
  async embed(texts: string[]): Promise<Array<Float32Array | number[]>> {
    return texts.map((text) => {
      const vector = new Float32Array(VECTOR_DIMENSIONS)
      let hash = 0x811c9dc5
      for (let i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i)
        hash = Math.imul(hash, 0x01000193) >>> 0
      }
      // Scatter 96 hash-derived features across the dimensions, then
      // normalize so the vectors are comparable (unit sphere).
      for (let feature = 0; feature < 96; feature++) {
        hash = Math.imul(hash ^ (feature + 1), 0x01000193) >>> 0
        const index = hash % VECTOR_DIMENSIONS
        vector[index] += (hash >>> 30) & 1 ? 1 : -1
      }
      let norm = 0
      for (let i = 0; i < VECTOR_DIMENSIONS; i++) norm += vector[i] * vector[i]
      norm = Math.sqrt(norm) || 1
      for (let i = 0; i < VECTOR_DIMENSIONS; i++) vector[i] /= norm
      return vector
    })
  }
}

const FIXTURE_TURTLE = `
@prefix schema: <http://schema.org/> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
<urn:session:ci> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://schema.org/Conversation> .
<urn:session:ci> <http://schema.org/dateCreated> "2026-09-05" .
<urn:session:ci> <http://schema.org/hasPart> <urn:session:ci/msg/0> .
<urn:session:ci/msg/0> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://schema.org/Message> .
<urn:session:ci/msg/0> <http://schema.org/text> "I painted that lake sunrise last year and it is special to me." .
<urn:session:ci/msg/0> <http://schema.org/position> "0"^^<http://www.w3.org/2001/XMLSchema#integer> .
<urn:session:ci/msg/0> <http://schema.org/author> "assistant" .
<urn:session:ci/msg/0> <http://www.w3.org/ns/prov#wasGeneratedBy> <urn:session:ci> .
<urn:session:ci> <http://schema.org/hasPart> <urn:session:ci/msg/1> .
<urn:session:ci/msg/1> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://schema.org/Message> .
<urn:session:ci/msg/1> <http://schema.org/text> "When did Melanie paint a sunrise?" .
<urn:session:ci/msg/1> <http://schema.org/position> "1"^^<http://www.w3.org/2001/XMLSchema#integer> .
<urn:session:ci/msg/1> <http://schema.org/author> "user" .
<urn:session:ci/msg/1> <http://www.w3.org/ns/prov#wasGeneratedBy> <urn:session:ci> .
`

describe("sqlite-vec vec0 under a bun:sqlite handle", () => {
  let db: Database
  let client: SqliteWorldsSdk

  beforeAll(async () => {
    db = new Database(":memory:")
    const warnSpy = spyOn(console, "warn")
    client = await createSqliteWorldsSdk({
      path: ":memory:",
      db,
      embeddingService: new DeterministicEmbeddingService(),
      vectorDimensions: VECTOR_DIMENSIONS,
      searchIndexOnImport: "disabled",
    })
    expect(
      warnSpy.mock.calls
        .flat()
        .filter((a) => String(a).includes("sqlite-vec extension unavailable"))
    ).toEqual([])
    warnSpy.mockRestore()

    await client.import({
      source: {
        kind: "serialized",
        data: FIXTURE_TURTLE,
        contentType: "text/turtle",
      },
    })
  })

  afterAll(() => {
    client.close()
    db.close()
  })

  it("loads sqlite-vec and creates the vec0 virtual table", () => {
    const vecTables = db
      .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'chunks_vec'")
      .all() as Array<{ name: string }>
    expect(vecTables).toHaveLength(1)
    expect(vecTables[0]!.name).toBe("chunks_vec")
  })

  it("reindex writes embeddings into chunks_vec (not silently dropped)", async () => {
    const result = await client.reindex()
    expect(result.processedQuadCount).toBeGreaterThan(0)
    expect(result.chunkRowCount).toBeGreaterThan(0)

    const vecRowCount = db.query("SELECT count(*) AS n FROM chunks_vec").get() as { n: number }
    expect(Number(vecRowCount.n)).toBe(result.chunkRowCount)
  })

  it("hybrid search returns rows and the vec0 knn arm executes", async () => {
    const response = await client.search({ query: "sunrise" })
    const results = response.results ?? []
    expect(results.length).toBeGreaterThan(0)

    // Direct vec0 knn through the same handle proves the vector arm runs —
    // FTS5 matching alone would still return rows above.
    const vector = (await new DeterministicEmbeddingService().embed(["sunrise"]))[0]
    const knn = db
      .query("SELECT rowid FROM chunks_vec WHERE embedding MATCH ? AND k = ?")
      .all(JSON.stringify(Array.from(vector)), 3)
    expect(knn.length).toBeGreaterThan(0)
  })
})
