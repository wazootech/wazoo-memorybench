import { stat } from "node:fs/promises"
import { join } from "node:path"
import {
  TFJS_USE_EMBEDDING_DIMENSIONS,
  TfjsUseEmbeddingService,
} from "../src/providers/worlds/tfjs-use-embedding-service"

const modelDir = process.env.TFJS_USE_MODEL_DIR || join(process.cwd(), "data", "models", "tfjs-use")
const artifacts = [
  "model.json",
  "vocab.json",
  ...Array.from({ length: 7 }, (_, index) => `group1-shard${index + 1}of7`),
]

for (const artifact of artifacts) {
  const info = await stat(join(modelDir, artifact))
  if (info.size === 0) throw new Error(`TF.js USE artifact is empty: ${artifact}`)
}

const vectors = await new TfjsUseEmbeddingService(modelDir).embed([
  "deterministic local embedding smoke",
])
const vector = vectors[0]
if (!vector || vector.length !== TFJS_USE_EMBEDDING_DIMENSIONS) {
  throw new Error(`Expected ${TFJS_USE_EMBEDDING_DIMENSIONS} dimensions`)
}
if (!vector.every(Number.isFinite)) throw new Error("TF.js USE returned a non-finite vector")

console.log(
  JSON.stringify({
    modelDir,
    dimensions: vector.length,
    finite: true,
    artifacts: artifacts.length,
  })
)
