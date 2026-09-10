import { mkdir, rename, stat } from "node:fs/promises"
import { join } from "node:path"

const modelDir = process.env.TFJS_USE_MODEL_DIR || join(process.cwd(), "data", "models", "tfjs-use")
const force = process.argv.includes("--force")

const artifacts = [
  {
    name: "model.json",
    url: "https://tfhub.dev/tensorflow/tfjs-model/universal-sentence-encoder-lite/1/default/1/model.json?tfjs-format=file",
  },
  {
    name: "vocab.json",
    url: "https://storage.googleapis.com/tfjs-models/savedmodel/universal_sentence_encoder/vocab.json",
  },
  ...Array.from({ length: 7 }, (_, index) => ({
    name: `group1-shard${index + 1}of7`,
    url: `https://tfhub.dev/tensorflow/tfjs-model/universal-sentence-encoder-lite/1/default/1/group1-shard${index + 1}of7?tfjs-format=file`,
  })),
]

async function downloadArtifact(name: string, url: string): Promise<void> {
  const destination = join(modelDir, name)
  if (!force) {
    try {
      const existing = await stat(destination)
      if (existing.size > 0) {
        console.log(`exists ${destination}`)
        return
      }
    } catch {
      // Download missing artifacts.
    }
  }

  console.log(`download ${name}`)
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`Failed to download ${name}: ${response.status} ${response.statusText}`)
  }
  const temporary = `${destination}.partial`
  await Bun.write(temporary, await response.arrayBuffer())
  await rename(temporary, destination)
}

await mkdir(modelDir, { recursive: true })
for (const artifact of artifacts) {
  await downloadArtifact(artifact.name, artifact.url)
}
console.log(`TF.js USE model is ready at ${modelDir}`)
