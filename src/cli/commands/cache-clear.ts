import { rm } from "node:fs/promises"
import { join } from "node:path"
import { logger } from "../../utils/logger"

const CACHE_ROOT = join(process.cwd(), "data", "cache")

/**
 * Escape hatch to reset the shared content-addressed cache (embeddings +
 * extraction) under data/cache/. Per-run state (data/runs, data/providers)
 * is deliberately untouched.
 */
export async function cacheClearCommand(): Promise<void> {
  try {
    await rm(CACHE_ROOT, { recursive: true, force: true })
    logger.success(
      "Cleared shared cache at data/cache/ (embeddings + extraction). Per-run state untouched."
    )
  } catch (err) {
    logger.error(`Failed to clear cache: ${err}`)
  }
}
