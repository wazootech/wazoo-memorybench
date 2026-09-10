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
import type { WorldsProvider } from "./index"

export type WorldsAgentTools = ReturnType<typeof createTools>

/**
 * createWorldsAgentTools builds the AI SDK tool set bound to one container's
 * graph. Call after initialize + ingest; the returned tools see exactly what
 * the container's client sees.
 */
export async function createWorldsAgentTools(
  provider: WorldsProvider,
  containerTag: string
): Promise<WorldsAgentTools> {
  const client = await provider.getClientForContainer(containerTag)
  const rawTools = createTools({ client }) as unknown as Record<string, unknown>
  return Object.fromEntries(
    Object.entries(rawTools).filter(
      ([name]) => name !== "discoverSchema" && name !== "searchEntities"
    )
  ) as unknown as WorldsAgentTools
}
