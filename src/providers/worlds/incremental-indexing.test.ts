import { describe, expect, it } from "bun:test"
import { Database } from "bun:sqlite"
import type { EmbeddingService } from "@worlds/sdk"
import { createSqliteWorldsSdk } from "@worlds/sqlite"

const VECTOR_DIMENSIONS = 8

class DeterministicEmbeddingService implements EmbeddingService {
  async embed(texts: string[]): Promise<Array<Float32Array | number[]>> {
    return texts.map((text) => {
      const vector = new Float32Array(VECTOR_DIMENSIONS)
      if (text.toLowerCase().includes("alpha")) vector[0] = 1
      if (text.toLowerCase().includes("beta")) vector[1] = 1
      return vector
    })
  }
}

function messageTurtle(id: string, text: string): string {
  return `
@prefix schema: <http://schema.org/> .
<urn:session:${id}> a schema:Conversation ;
  schema:dateCreated "2026-09-10" ;
  schema:hasPart <urn:session:${id}/message/0> .
<urn:session:${id}/message/0> a schema:Message ;
  schema:text "${text}" ;
  schema:position "0" ;
  schema:author "user" ;
  schema:wasGeneratedBy <urn:session:${id}> .
`
}

describe("incremental SQLite indexing", () => {
  it("projects each imported mutation without a full reindex", async () => {
    const db = new Database(":memory:")
    const client = await createSqliteWorldsSdk({
      path: ":memory:",
      db,
      embeddingService: new DeterministicEmbeddingService(),
      vectorDimensions: VECTOR_DIMENSIONS,
      searchIndexOnImport: "incremental",
    })

    try {
      await client.import({
        source: {
          kind: "serialized",
          data: messageTurtle("alpha", "alpha memory"),
          contentType: "text/turtle",
        },
      })
      const firstRows = db.query("SELECT count(*) AS n FROM chunks_vec").get() as { n: number }
      const firstSearch = await client.search({ query: "alpha" })

      await client.import({
        source: {
          kind: "serialized",
          data: messageTurtle("beta", "beta memory"),
          contentType: "text/turtle",
        },
      })
      const secondRows = db.query("SELECT count(*) AS n FROM chunks_vec").get() as { n: number }
      const secondSearch = await client.search({ query: "beta" })

      expect(Number(firstRows.n)).toBeGreaterThan(0)
      expect(Number(secondRows.n)).toBeGreaterThan(Number(firstRows.n))
      expect(firstSearch.results?.length ?? 0).toBeGreaterThan(0)
      expect(secondSearch.results?.length ?? 0).toBeGreaterThan(0)
    } finally {
      client.close()
      db.close()
    }
  })
})
