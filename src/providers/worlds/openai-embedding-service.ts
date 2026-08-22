import { createOpenAI } from "@ai-sdk/openai";
import { embedMany } from "ai";
import type { EmbeddingService } from "@worlds/sdk/search-index/embedding-service";
import { logger } from "../../utils/logger";

export type { EmbeddingService };

export interface OpenAIEmbeddingServiceOptions {
  apiKey?: string;
  baseUrl?: string;
  modelName?: string;
}

export class OpenAIEmbeddingService implements EmbeddingService {
  private readonly model;

  constructor(options: OpenAIEmbeddingServiceOptions = {}) {
    const openai = createOpenAI({
      apiKey: options.apiKey || process.env.OPENAI_API_KEY || "ollama",
      // EMBEDDING_BASE_URL decouples embeddings from OPENAI_BASE_URL, so
      // pointing OPENAI_BASE_URL at DeepSeek (which has no embedding
      // endpoint) can never redirect the embedding path.
      baseURL: options.baseUrl ||
        process.env.EMBEDDING_BASE_URL ||
        process.env.OPENAI_BASE_URL ||
        "http://localhost:11434/v1",
    });
    const modelName = options.modelName || process.env.EMBEDDING_MODEL ||
      "nomic-embed-text";
    this.model = openai.textEmbeddingModel(modelName);
  }

  async embed(texts: string[]): Promise<Array<Float32Array | number[]>> {
    if (texts.length === 0) return [];

    const MAX_BATCH_SIZE = 64;
    const allVectors: Float32Array[] = [];

    for (let i = 0; i < texts.length; i += MAX_BATCH_SIZE) {
      const batch = texts.slice(i, i + MAX_BATCH_SIZE);
      try {
        const { embeddings } = await embedMany({
          model: this.model,
          values: batch,
        });
        allVectors.push(...embeddings.map((e) => new Float32Array(e)));
      } catch (err) {
        logger.error(
          `OpenAI/Ollama embed failed (batch ${
            Math.floor(i / MAX_BATCH_SIZE) + 1
          }, ${batch.length} texts): ${err}`,
        );
        throw err;
      }
    }

    logger.debug(
      `OpenAI/Ollama embed: ${texts.length} texts → ${allVectors.length} vectors (${
        allVectors[0]?.length ?? 0
      }d)`,
    );

    return allVectors;
  }
}
