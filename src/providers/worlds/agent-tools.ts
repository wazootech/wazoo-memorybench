import { tool } from "ai"
import type { Tool } from "ai"
import type { WorldsSdkInterface } from "@worlds/sdk"
import type { ExportRequest, ImportRequest } from "@worlds/sdk/quad-store"
import type { ReindexRequest } from "@worlds/sdk/search-index"
import type { SparqlRequest } from "@worlds/sdk/sparql-engine"
import { z } from "zod"
import type { WorldsProvider } from "./index"

export type WorldsAgentProfile = "full" | "ingest" | "recall" | "administrative"
export type WorldsAgentTool = Tool<any, any>
export type WorldsAgentTools = Record<string, WorldsAgentTool>

export interface EntityResolverLike {
  resolve(input: Record<string, unknown>): Promise<unknown>
  lookup(id: string): Promise<unknown>
  merge(sourceId: string, targetId: string): Promise<unknown>
  stats(): Promise<unknown>
}

const EXECUTE_SPARQL_DESCRIPTION =
  "Execute a read-only SPARQL query against the graph. Use bounded SELECT queries to discover classes and predicates when the schema is unknown."
const SEARCH_WORLD_DESCRIPTION =
  "Search indexed graph literals using semantic and keyword retrieval. Use this to find candidate evidence and resource IRIs."
const IMPORT_RDF_DESCRIPTION =
  "Import validated RDF into the graph. This mutates memory and is intended for ingestion or administration."
const EXPORT_RDF_DESCRIPTION = "Export durable RDF from the graph for inspection, backup, or audit."
const REINDEX_WORLD_DESCRIPTION =
  "Rebuild derived search structures from the durable graph. Use for repair, audit, or bulk-import completion; normal mutations use incremental projection."
const RESOLVE_ENTITY_DESCRIPTION =
  "Resolve a source mention to a canonical entity using the configured identity policy and durable identity store. Use during ingestion or normalization, not recall."

const searchInput = z.object({
  query: z.string().describe("Keyword or natural-language graph search query."),
  include: z
    .object({
      subjects: z.array(z.string()).optional(),
      predicates: z.array(z.string()).optional(),
      graphs: z.array(z.string()).optional(),
    })
    .optional(),
  exclude: z
    .object({
      subjects: z.array(z.string()).optional(),
      predicates: z.array(z.string()).optional(),
      graphs: z.array(z.string()).optional(),
    })
    .optional(),
  topK: z.number().int().positive().max(100).optional(),
  minScore: z.number().min(0).max(1).optional(),
})

const sparqlInput = z.object({
  query: z.string().describe("SPARQL query. Always include a bounded LIMIT."),
  baseIri: z.string().optional(),
  timeoutMs: z.number().int().positive().max(120_000).optional(),
})

const importInput = z.object({
  mode: z.enum(["merge", "replace"]).optional(),
  source: z.object({
    kind: z.literal("serialized"),
    data: z.string(),
    contentType: z.string().optional(),
  }),
})

const exportInput = z.object({
  format: z.object({
    kind: z.literal("serialized"),
    contentType: z.string().optional(),
  }),
})

const reindexInput = z.object({
  readPageSize: z.number().int().positive().max(10_000).optional(),
})

const resolveEntityInput = z.object({
  operation: z.enum(["resolve", "lookup", "merge", "stats"]),
  name: z.string().optional(),
  classIri: z.string().optional(),
  embedding: z.array(z.number()).optional(),
  scopedUrn: z.string().optional(),
  sessionId: z.string().optional(),
  id: z.string().optional(),
  sourceId: z.string().optional(),
  targetId: z.string().optional(),
})

function isSparqlUpdate(query: string): boolean {
  return /\b(INSERT|DELETE|DROP|CLEAR|LOAD|CREATE|WITH)\b/i.test(query)
}

function createSearchWorld(client: WorldsSdkInterface): WorldsAgentTool {
  return tool({
    description: SEARCH_WORLD_DESCRIPTION,
    inputSchema: searchInput,
    execute: async (request) => {
      try {
        return { success: true, data: await client.search(request) }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : "Unknown error" }
      }
    },
  })
}

function createExecuteSparql(client: WorldsSdkInterface): WorldsAgentTool {
  return tool({
    description: EXECUTE_SPARQL_DESCRIPTION,
    inputSchema: sparqlInput,
    execute: async (request) => {
      if (isSparqlUpdate(request.query)) {
        return {
          success: false,
          error: "SPARQL updates are disabled for this agent profile.",
        }
      }
      try {
        const response = await client.sparql(request as SparqlRequest)
        return {
          success: true,
          data: response.kind === "void" ? null : (response as { data?: unknown }).data,
        }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : "Unknown error" }
      }
    },
  })
}

function createImportRdf(client: WorldsSdkInterface): WorldsAgentTool {
  return tool({
    description: IMPORT_RDF_DESCRIPTION,
    inputSchema: importInput,
    execute: async (request) => {
      try {
        await client.import({
          mode: request.mode ?? "merge",
          source: request.source,
        } as ImportRequest)
        return { success: true, message: "RDF imported successfully." }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : "Unknown error" }
      }
    },
  })
}

function createExportRdf(client: WorldsSdkInterface): WorldsAgentTool {
  return tool({
    description: EXPORT_RDF_DESCRIPTION,
    inputSchema: exportInput,
    execute: async (request) => {
      try {
        const response = await client.export({ format: request.format } as ExportRequest)
        return { success: true, data: response.kind === "serialized" ? response.data : null }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : "Unknown error" }
      }
    },
  })
}

function createReindexWorld(client: WorldsSdkInterface): WorldsAgentTool {
  return tool({
    description: REINDEX_WORLD_DESCRIPTION,
    inputSchema: reindexInput,
    execute: async (request) => {
      try {
        return {
          success: true,
          data: await client.reindex(request as ReindexRequest),
          message: "Derived search structures rebuilt from the durable graph.",
        }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : "Unknown error" }
      }
    },
  })
}

function createResolveEntity(resolver: EntityResolverLike): WorldsAgentTool {
  return tool({
    description: RESOLVE_ENTITY_DESCRIPTION,
    inputSchema: resolveEntityInput,
    execute: async (request) => {
      try {
        switch (request.operation) {
          case "resolve":
            if (!request.name) return { success: false, error: "resolve requires 'name'." }
            return {
              success: true,
              data: await resolver.resolve({ ...request }),
            }
          case "lookup":
            if (!request.id) return { success: false, error: "lookup requires 'id'." }
            return { success: true, data: await resolver.lookup(request.id) }
          case "merge":
            if (!request.sourceId || !request.targetId) {
              return { success: false, error: "merge requires 'sourceId' and 'targetId'." }
            }
            return {
              success: true,
              data: await resolver.merge(request.sourceId, request.targetId),
            }
          case "stats":
            return { success: true, data: await resolver.stats() }
        }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : "Unknown error" }
      }
    },
  })
}

const PROFILE_TOOLS: Record<Exclude<WorldsAgentProfile, "full">, string[]> = {
  recall: ["searchWorld", "executeSparql"],
  ingest: ["resolveEntity", "importRdf", "executeSparql", "exportRdf"],
  administrative: ["executeSparql", "importRdf", "exportRdf", "reindexWorld", "resolveEntity"],
}

export function createWorldsToolSet(
  client: WorldsSdkInterface,
  profile: WorldsAgentProfile = "full",
  entityResolver?: EntityResolverLike
): WorldsAgentTools {
  const tools: WorldsAgentTools = {
    searchWorld: createSearchWorld(client),
    executeSparql: createExecuteSparql(client),
    importRdf: createImportRdf(client),
    exportRdf: createExportRdf(client),
    reindexWorld: createReindexWorld(client),
  }
  if (entityResolver) tools.resolveEntity = createResolveEntity(entityResolver)
  if (profile === "full") return tools
  const allowed = new Set(PROFILE_TOOLS[profile])
  return Object.fromEntries(Object.entries(tools).filter(([name]) => allowed.has(name)))
}

export async function createWorldsAgentTools(
  provider: WorldsProvider,
  containerTag: string,
  profile: WorldsAgentProfile = "recall",
  entityResolver?: EntityResolverLike
): Promise<WorldsAgentTools> {
  const client = await provider.getClientForContainer(containerTag)
  return createWorldsToolSet(client, profile, entityResolver)
}
