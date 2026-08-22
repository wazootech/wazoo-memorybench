import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { embedMany } from "ai";
import type { EmbeddingService } from "@worlds/sdk/search-index/embedding-service";
import { logger } from "../../utils/logger";

export type { EmbeddingService };

export const GEMINI_EMBEDDING_DIMENSIONS = 768;
const MAX_BATCH_SIZE = 100;
const QUOTA_RPM = 2500;
const QUOTA_WINDOW_MS = 60_000;

/**
 * Module-level sliding-window rate limiter shared across all
 * GeminiEmbeddingService instances. Each batch of N texts counts as
 * N requests against the Gemini quota (3000 RPM).
 */
const requestTimestamps: number[] = [];
async function waitForQuota(requestCount: number): Promise<void> {
  const now = Date.now();
  while (
    requestTimestamps.length > 0 && requestTimestamps[0] < now - QUOTA_WINDOW_MS
  ) {
    requestTimestamps.shift();
  }
  const currentUsage = requestTimestamps.length;
  if (currentUsage + requestCount > QUOTA_RPM) {
    const oldest = requestTimestamps[0] ?? now;
    const waitMs = oldest + QUOTA_WINDOW_MS - now + 1000;
    logger.debug(
      `Rate limiter: ${currentUsage}/${QUOTA_RPM} used, waiting ${
        (waitMs / 1000).toFixed(1)
      }s`,
    );
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    return waitForQuota(requestCount);
  }
  for (let i = 0; i < requestCount; i++) {
    requestTimestamps.push(Date.now());
  }
}

/**
 * GeminiEmbeddingService implements @worlds/sdk's EmbeddingService interface
 * using Google's gemini-embedding-2 via the Vercel AI SDK.
 *
 * Gemini's BatchEmbedContents API caps at 100 items per request, so we chunk
 * internally. A module-level rate limiter ensures parallel containers stay
 * under the 3000 RPM quota. Output is truncated to 768 dimensions.
 */
export class GeminiEmbeddingService implements EmbeddingService {
  private readonly model;

  constructor(apiKey: string) {
    const google = createGoogleGenerativeAI({ apiKey });
    this.model = google.textEmbeddingModel("gemini-embedding-2");
  }

  async embed(texts: string[]): Promise<Array<Float32Array | number[]>> {
    if (texts.length === 0) return [];

    const allVectors: Float32Array[] = [];

    for (let i = 0; i < texts.length; i += MAX_BATCH_SIZE) {
      const batch = texts.slice(i, i + MAX_BATCH_SIZE);
      await waitForQuota(batch.length);
      try {
        const { embeddings } = await embedMany({
          model: this.model,
          values: batch,
          providerOptions: {
            google: { outputDimensionality: GEMINI_EMBEDDING_DIMENSIONS },
          },
        });
        allVectors.push(...embeddings.map((e) => new Float32Array(e)));
      } catch (err) {
        logger.error(
          `Gemini embed failed (batch ${
            Math.floor(i / MAX_BATCH_SIZE) + 1
          }, ${batch.length} texts): ${err}`,
        );
        throw err;
      }
    }

    logger.debug(
      `Gemini embed: ${texts.length} texts → ${allVectors.length} vectors (${
        allVectors[0]?.length ?? 0
      }d)`,
    );

    return allVectors;
  }
}
