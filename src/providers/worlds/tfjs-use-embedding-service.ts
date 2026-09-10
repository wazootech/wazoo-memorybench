import { UniversalSentenceEncoderEmbeddingService } from "@worlds/sdk/tfjs-use"
import type { EmbeddingService } from "@worlds/sdk/search-index/embedding-service"
import { join } from "node:path"

export const TFJS_USE_EMBEDDING_DIMENSIONS = 512
export const TFJS_USE_MODEL_DIR = join(process.cwd(), "data", "models", "tfjs-use")

export class TfjsUseEmbeddingService implements EmbeddingService {
  private readonly service: UniversalSentenceEncoderEmbeddingService

  constructor(modelDir: string = TFJS_USE_MODEL_DIR) {
    this.service = new UniversalSentenceEncoderEmbeddingService({
      modelUrl: join(modelDir, "model.json"),
      vocabUrl: join(modelDir, "vocab.json"),
    })
  }

  embed(texts: string[]): Promise<number[][]> {
    return this.service.embed(texts)
  }
}
