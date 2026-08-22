import { createHash } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import type { EmbeddingService } from "@worlds/sdk/search-index/embedding-service"
import { logger } from "../../utils/logger"

const CACHE_ROOT = join(process.cwd(), "data", "cache", "embeddings")

interface CachedVector {
  dims: number
  values: number[]
}

function fileFor(root: string, label: string, hash: string): string {
  return join(root, label, `${hash}.json`)
}

async function tryRead(file: string): Promise<Float32Array | null> {
  try {
    const raw = await readFile(file, "utf8")
    const parsed = JSON.parse(raw) as CachedVector
    // A corrupt or *mismatched* entry (dims not matching the stored vector
    // length) is treated as a miss and re-embedded: serving it could poison
    // an index built with fixed vectorDimensions.
    if (
      !Array.isArray(parsed.values) ||
      typeof parsed.dims !== "number" ||
      parsed.dims !== parsed.values.length
    ) {
      return null
    }
    return Float32Array.from(parsed.values)
  } catch {
    return null
  }
}

async function writeCache(file: string, vec: Float32Array | number[]): Promise<void> {
  const arr = vec instanceof Float32Array ? vec : Float32Array.from(vec)
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify({ dims: arr.length, values: Array.from(arr) }), "utf8")
}

/** Short hex fingerprint of the resolved embedding endpoint for label scoping. */
function scopeHash(scope: string): string {
  return createHash("sha256").update(scope).digest("hex").slice(0, 12)
}

/**
 * CachedEmbeddingService wraps any EmbeddingService with a content-addressed
 * on-disk cache under `data/cache/embeddings/{label}/`. Entries are keyed by
 * `sha256(text)` under a per-service label (`{provider}/{model}`, plus a
 * short hash of the resolved base URL when a scope is supplied) and are
 * immutable — never overwritten. A corrupt or mismatched entry is treated as
 * a miss and re-embedded (self-invalidating). Cache writes are best-effort:
 * an unwritable cache degrades to a slower, still-correct run, never a
 * failed embed. The cache is shared across runs (not per-containerTag), so a
 * fresh run ID re-embeds nothing. `--force` / `clear()` never touch this
 * cache; use the `cache-clear` command for an explicit reset.
 */
export class CachedEmbeddingService implements EmbeddingService {
  private readonly inner: EmbeddingService
  private readonly label: string
  private readonly cacheRoot: string

  constructor(inner: EmbeddingService, label: string, scope?: string, cacheRoot?: string) {
    this.inner = inner
    this.label = scope ? `${label}/${scopeHash(scope)}` : label
    this.cacheRoot = cacheRoot ?? CACHE_ROOT
  }

  async embed(texts: string[]): Promise<Array<Float32Array | number[]>> {
    if (texts.length === 0) return []

    const hashes = texts.map((t) => createHash("sha256").update(t).digest("hex"))
    const vectors: (Float32Array | null)[] = new Array(texts.length).fill(null)
    const missing: number[] = []

    await Promise.all(
      hashes.map(async (hash, i) => {
        const cached = await tryRead(fileFor(this.cacheRoot, this.label, hash))
        if (cached) vectors[i] = cached
        else missing.push(i)
      })
    )

    if (missing.length > 0) {
      const fresh = await this.inner.embed(missing.map((i) => texts[i]))
      await Promise.all(
        missing.map(async (index, k) => {
          const vec = fresh[k]
          const arr = vec instanceof Float32Array ? vec : Float32Array.from(vec)
          vectors[index] = arr
          // Best-effort write: a read-only cache or full disk must not fail
          // the embed — the vectors are already computed.
          try {
            await writeCache(fileFor(this.cacheRoot, this.label, hashes[index]), arr)
          } catch (err) {
            logger.warn(
              `Failed to write embedding cache entry (${this.label}): ${
                err instanceof Error ? err.message : err
              }`
            )
          }
        })
      )
      logger.debug(
        `CachedEmbeddingService[${this.label}]: ${
          texts.length - missing.length
        }/${texts.length} hits, ${missing.length} embedded fresh`
      )
    } else {
      logger.debug(
        `CachedEmbeddingService[${this.label}]: ${texts.length}/${texts.length} cache hits`
      )
    }

    return vectors as Float32Array[]
  }
}
