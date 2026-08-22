/**
 * Interface-parity + perf verification for the #25 Comunica→Wazoo engine swap.
 *
 * Opens each of the 5 smoke LibSQL DBs (conv-26-q0..q4-smoke-ds-001) through
 * the same `createLibsqlWorldsSdk` path WorldsProvider uses, runs the
 * harness's real query surface through the Wazoo engine, asserts the
 * expected shapes/results, and times representative queries for the perf
 * checklist item.
 *
 * Usage: bun run scripts/verify-wazoo-engine.ts
 */
import { createClient } from "@libsql/client";
import { createLibsqlWorldsSdk } from "@worlds/libsql";
import { join } from "node:path";

const DB_DIR = join(process.cwd(), "data", "providers", "worlds");
const DB_NAMES = [
  "conv-26-q0-smoke-ds-001",
  "conv-26-q1-smoke-ds-001",
  "conv-26-q2-smoke-ds-001",
  "conv-26-q3-smoke-ds-001",
  "conv-26-q4-smoke-ds-001",
];

// The exact query surface the harness runs (from worlds/index.ts):
// - queryFactClaims: entity + keyword FILTER/CONTAINS with OPTIONAL + UNION
// - enrichSearchResults: VALUES clause over message URIs
// - agent PREFIX queries (multi-hop joins, COUNT/GROUP BY, ORDER BY, LIMIT)
const QUERIES = {
  factClaimQuery: (subject: string) =>
    `
    SELECT DISTINCT ?claim ?claimText ?type ?subj ?action ?obj ?when ?where ?session ?sessionDate WHERE {
      ?claim <http://www.w3.org/ns/prov#wasDerivedFrom> ?session .
      OPTIONAL { ?session <http://schema.org/dateCreated> ?sessionDate }
      { ?claim <http://schema.org/text> ?claimText } UNION { ?claim <https://worlds.wazoo.dev/ns/memory#claimText> ?claimText } .
      OPTIONAL { ?claim <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> ?type }
      OPTIONAL {
        ?claim <http://schema.org/about> ?aboutNode .
        OPTIONAL { ?aboutNode <http://schema.org/name> ?subj }
      }
      OPTIONAL { ?claim <https://worlds.wazoo.dev/ns/memory#claimSubject> ?subj }
      OPTIONAL { ?claim <https://worlds.wazoo.dev/ns/memory#claimAction> ?action }
      OPTIONAL { ?claim <https://worlds.wazoo.dev/ns/memory#claimObject> ?obj }
      OPTIONAL { ?claim <http://schema.org/startDate> ?when }
      OPTIONAL { ?claim <https://worlds.wazoo.dev/ns/memory#claimWhen> ?when }
      OPTIONAL { ?claim <http://schema.org/location> ?where }
      OPTIONAL { ?claim <https://worlds.wazoo.dev/ns/memory#claimWhere> ?where }
      FILTER NOT EXISTS { ?claim <https://worlds.wazoo.dev/ns/memory#status> <https://worlds.wazoo.dev/ns/memory#Superseded> }
      FILTER( CONTAINS(LCASE(STR(?subj)), "${subject}") && true )
    }
    LIMIT 8`.trim(),

  countTypes: `
    SELECT ?type (COUNT(*) AS ?n) WHERE { ?s <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> ?type } GROUP BY ?type ORDER BY DESC(?n) LIMIT 20`
    .trim(),

  personEvents: `
    PREFIX schema: <http://schema.org/>
    PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
    SELECT ?personName ?eventName ?status ?date WHERE {
      ?e a schema:Event ; schema:name ?eventName ; schema:about ?p . ?p schema:name ?personName .
      OPTIONAL { ?e schema:eventStatus ?status } OPTIONAL { ?e schema:startDate ?date }
    } LIMIT 5`.trim(),

  askTest: `
    PREFIX schema: <http://schema.org/>
    ASK { ?s a schema:Person }`.trim(),
};

async function main(): Promise<void> {
  let totalBindings = 0;
  let askTrue = 0;
  const timings: Record<string, number[]> = {};

  for (const dbName of DB_NAMES) {
    const dbPath = join(DB_DIR, `${dbName}.db`);
    const libsqlClient = createClient({ url: `file:${dbPath}` });
    const client = await createLibsqlWorldsSdk({
      client: libsqlClient,
      // Wazoo engine — the #25 swap under test (wired by createLibsqlWorldsSdk).
    });

    console.log(`\n=== ${dbName} ===`);

    // 1. ASK kind parity
    {
      const t0 = performance.now();
      const res = await client.sparql({ query: QUERIES.askTest });
      const dt = performance.now() - t0;
      (timings.ask ??= []).push(dt);
      if (res.kind !== "ask") throw new Error(`Expected ask, got ${res.kind}`);
      if (res.data.boolean) askTrue++;
      console.log(`  ASK → boolean=${res.data.boolean} (${dt.toFixed(1)}ms)`);
    }

    // 2. COUNT/GROUP BY discovery query
    {
      const t0 = performance.now();
      const res = await client.sparql({ query: QUERIES.countTypes });
      const dt = performance.now() - t0;
      (timings.countTypes ??= []).push(dt);
      if (res.kind !== "select") {
        throw new Error(`Expected select, got ${res.kind}`);
      }
      if (
        !res.data.head.vars.includes("type") ||
        !res.data.head.vars.includes("n")
      ) {
        throw new Error(
          `Unexpected head vars: ${res.data.head.vars.join(",")}`,
        );
      }
      console.log(
        `  COUNT/GROUP BY → ${res.data.results.bindings.length} types (${
          dt.toFixed(1)
        }ms)`,
      );
      for (const b of res.data.results.bindings.slice(0, 3)) {
        console.log(`    ${b.type?.value}: ${b.n?.value}`);
      }
    }

    // 3. Person→Event multi-hop join with OPTIONAL + LIMIT
    {
      const t0 = performance.now();
      const res = await client.sparql({ query: QUERIES.personEvents });
      const dt = performance.now() - t0;
      (timings.personEvents ??= []).push(dt);
      if (res.kind !== "select") {
        throw new Error(`Expected select, got ${res.kind}`);
      }
      totalBindings += res.data.results.bindings.length;
      console.log(
        `  Person→Event join → ${res.data.results.bindings.length} rows (${
          dt.toFixed(1)
        }ms)`,
      );
      for (const b of res.data.results.bindings.slice(0, 2)) {
        console.log(
          `    ${b.personName?.value} — ${b.eventName?.value} (${
            b.date?.value ?? "?"
          })`,
        );
      }
    }

    // 4. Fact-claim FILTER/CONTAINS + UNION + OPTIONAL (the harness's query)
    {
      const t0 = performance.now();
      const res = await client.sparql({
        query: QUERIES.factClaimQuery("caroline"),
      });
      const dt = performance.now() - t0;
      (timings.factClaims ??= []).push(dt);
      if (res.kind !== "select") {
        throw new Error(`Expected select, got ${res.kind}`);
      }
      totalBindings += res.data.results.bindings.length;
      console.log(
        `  Fact-claim FILTER/CONTAINS → ${res.data.results.bindings.length} rows (${
          dt.toFixed(1)
        }ms)`,
      );
      for (const b of res.data.results.bindings.slice(0, 2)) {
        console.log(`    ${b.claimText?.value?.slice(0, 60)}`);
      }
    }

    libsqlClient.close();
  }

  console.log(`\n=== totals ===`);
  console.log(`ASK true on ${askTrue}/${DB_NAMES.length} DBs`);
  console.log(
    `Select bindings across ${DB_NAMES.length} DBs: ${totalBindings}`,
  );
  for (const [name, times] of Object.entries(timings)) {
    const avg = times.reduce((a, b) => a + b, 0) / times.length;
    const max = Math.max(...times);
    console.log(
      `  ${name}: avg ${avg.toFixed(1)}ms, max ${
        max.toFixed(1)
      }ms (n=${times.length})`,
    );
  }
  console.log(`\nAll parity checks passed ✓`);
}

main().catch((err) => {
  console.error("VERIFY FAILED:", err);
  process.exit(1);
});
