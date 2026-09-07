/**
 * Agent tool wiring: exposes wazoo-tools' AI SDK tool surface over a
 * WorldsProvider container so agents can query the extracted graph
 * (searchWorld / searchEntities, executeSparql, discoverSchema, importRdf,
 * exportRdf) without touching provider internals.
 *
 * This is the memorybench side of wazoo-tools PR #7 ("canonical AI SDK tool
 * veneer over @worlds/sdk"): createTools accepts the WorldsSdkInterface that
 * getClientForContainer already returns — no adapter needed.
 *
 * TODO: import from `jsr:@wazoo/tools` once PR #7 merges and publishes; the
 * relative import tracks the local checkout in the meantime.
 */
import { createTools } from "../../../../wazoo-tools/src/mod"
import type { WorldsProvider } from "./index"

export type WorldsAgentTools = ReturnType<typeof createTools>

/**
 * createWorldsAgentTools builds the AI SDK tool set bound to one container's
 * graph. Call after initialize + ingest; the returned tools see exactly what
 * the container's client sees.
 */
export async function createWorldsAgentTools(
  provider: WorldsProvider,
  containerTag: string,
): Promise<WorldsAgentTools> {
  const client = await provider.getClientForContainer(containerTag)
  return createTools({ client })
}
