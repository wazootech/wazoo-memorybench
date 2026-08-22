import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { CachedEmbeddingService } from "./cached-embedding-service";

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })),
  );
});

async function tempCacheRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "wmb-embed-cache-"));
  tempDirs.push(dir);
  return dir;
}

function fakeInner(
  dims = 768,
  vectors?: Float32Array[],
): {
  embed: (texts: string[]) => Promise<Float32Array[]>;
  calls: () => number;
} {
  let callCount = 0;
  return {
    calls: () => callCount,
    embed: async (texts: string[]) => {
      callCount++;
      if (vectors) return vectors;
      // Deterministic per-text vector: value at index i is hash byte + position.
      return texts.map((t) => {
        const v = new Float32Array(dims);
        const h = createHash("sha256").update(t).digest();
        for (let i = 0; i < dims; i++) v[i] = h[i % h.length] / 255;
        return v;
      });
    },
  };
}

const sha = (t: string) => createHash("sha256").update(t).digest("hex");

describe("CachedEmbeddingService", () => {
  it("serves cache hits without calling the inner service", async () => {
    const root = await tempCacheRoot();
    const inner = fakeInner();
    const svc = new CachedEmbeddingService(
      inner,
      "openai/nomic-embed-text",
      undefined,
      root,
    );

    const a = await svc.embed(["hello world"]);
    const b = await svc.embed(["hello world"]);

    expect(a[0]).toBeInstanceOf(Float32Array);
    expect(b[0]).toEqual(a[0]);
    expect(inner.calls()).toBe(1); // second embed was a cache hit
  });

  it("treats a corrupt/mismatched entry as a miss and re-embeds", async () => {
    const root = await tempCacheRoot();
    const inner = fakeInner(768);
    const svc = new CachedEmbeddingService(
      inner,
      "openai/nomic-embed-text",
      undefined,
      root,
    );

    // First embed writes a correct 768-d entry.
    await svc.embed(["poison me"]);

    // Corrupt the entry: dims claims 768 but only 3 values stored.
    const dir = join(root, "openai/nomic-embed-text");
    await writeFile(
      join(dir, `${sha("poison me")}.json`),
      JSON.stringify({ dims: 768, values: [0.1, 0.2, 0.3] }),
    );

    const result = await svc.embed(["poison me"]);

    // Mismatch → miss → re-embedded with the inner service.
    expect(inner.calls()).toBe(2);
    expect((result[0] as Float32Array).length).toBe(768);
  });

  it("does not fail the embed when the cache cannot be written (best-effort writes)", async () => {
    const root = await tempCacheRoot();
    const inner = fakeInner(4);
    const svc = new CachedEmbeddingService(
      inner,
      "openai/nomic-embed-text",
      undefined,
      root,
    );

    // Make the label directory path unwritable by creating a FILE where the
    // directory must be created (the parent dir must exist first).
    await mkdir(join(root, "openai"), { recursive: true });
    await writeFile(join(root, "openai/nomic-embed-text"), "");

    const result = await svc.embed(["hello", "world"]);

    // Vectors still returned (computed from the inner service), cache write failed silently.
    expect(result).toHaveLength(2);
    expect((result[0] as Float32Array).length).toBe(4);
    expect(inner.calls()).toBe(1);
  });

  it("scopes cache entries to the resolved base URL", async () => {
    const root = await tempCacheRoot();
    const innerA = fakeInner();
    const innerB = fakeInner();
    const svcA = new CachedEmbeddingService(
      innerA,
      "openai/nomic-embed-text",
      "http://localhost:11434/v1",
      root,
    );
    const svcB = new CachedEmbeddingService(
      innerB,
      "openai/nomic-embed-text",
      "https://embeddings.example.com/v1",
      root,
    );

    await svcA.embed(["same text"]);
    await svcB.embed(["same text"]);

    // Same provider/model label but different base URLs → different cache dirs → both miss.
    expect(innerA.calls()).toBe(1);
    expect(innerB.calls()).toBe(1);

    // And each is stable across repeated embeds.
    await svcA.embed(["same text"]);
    await svcB.embed(["same text"]);
    expect(innerA.calls()).toBe(1);
    expect(innerB.calls()).toBe(1);

    // Entries landed in distinct scope-hashed directories keyed by base URL.
    const scopeA = createHash("sha256")
      .update("http://localhost:11434/v1")
      .digest("hex")
      .slice(0, 12);
    const scopeB = createHash("sha256")
      .update("https://embeddings.example.com/v1")
      .digest("hex")
      .slice(0, 12);
    const hash = sha("same text");
    const fileA = join(root, "openai/nomic-embed-text", scopeA, `${hash}.json`);
    const fileB = join(root, "openai/nomic-embed-text", scopeB, `${hash}.json`);
    expect(await readFile(fileA, "utf8")).toBeTruthy();
    expect(await readFile(fileB, "utf8")).toBeTruthy();
    expect(scopeA).not.toBe(scopeB);
  });
});
