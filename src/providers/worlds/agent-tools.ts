/**
 * Agent tool wiring: exposes wazoo-tools' AI SDK tool surface over a
 * WorldsProvider container so agents can query the extracted graph
 * (searchWorld, executeSparql, importRdf,
 * exportRdf) without touching provider internals.
 *
 * Consumes the canonical AI SDK tool veneer published from wazoo-tools as
 * `@wazoo/tools` (JSR, via the npm-compat registry): createTools accepts the
 * WorldsSdkInterface that getClientForContainer already returns — no adapter
 * needed.
 */
import { createTools } from "@wazoo/tools"
import type { EntityResolver } from "@wazoo/tools"
import type { WorldsProvider } from "./index"

export type WorldsAgentTools = ReturnType<typeof createTools>

export type WorldsAgentProfile = "full" | "ingest" | "recall" | "administrative"

const PROFILE_TOOLS: Record<Exclude<WorldsAgentProfile, "full">, string[]> = {
  recall: ["searchWorld", "executeSparql"],
  ingest: ["resolveEntity", "importRdf", "executeSparql", "exportRdf"],
  administrative: ["executeSparql", "importRdf", "exportRdf", "reindexWorld"],
}

/**
 * createWorldsAgentTools builds the AI SDK tool set bound to one container's
 * graph. Call after initialize + ingest; the returned tools see exactly what
 * the container's client sees.
 */
export async function createWorldsAgentTools(
  provider: WorldsProvider,
  containerTag: string,
  profile: WorldsAgentProfile = "recall",
  entityResolver?: EntityResolver
): Promise<WorldsAgentTools> {
  const client = await provider.getClientForContainer(containerTag)
  const rawTools = createTools({ client, entityResolver }) as unknown as Record<string, unknown>
  if (profile === "full") return rawTools as unknown as WorldsAgentTools
  const allowed = new Set(PROFILE_TOOLS[profile])
  return Object.fromEntries(
    Object.entries(rawTools).filter(([name]) => allowed.has(name))
  ) as unknown as WorldsAgentTools
}
