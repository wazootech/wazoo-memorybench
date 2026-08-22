/**
 * Worlds agent recollection smoke — parameterized tool-calling experiments.
 *
 * Runs an agentic answer loop over the indexed LibSQL DBs of a prior
 * MemoryBench run, with a configurable tool set so recollection strategies
 * can be A/B'd (SPARQL-only baseline vs SPARQL + search), answers judged
 * inline, and full JSONL traces captured for diagnosis.
 *
 * DeepSeek note: the Vercel AI SDK OpenAI provider cannot round-trip tool
 * calls against DeepSeek's API ("No tool call found for tool output with
 * call_id …"), so the deepseek path uses a raw /chat/completions agent loop
 * (proven against the API). Gemini keeps the AI SDK path.
 *
 *   # Run 1 — SPARQL-only recollection baseline
 *   bun --env-file=.env.local run scripts/worlds-agent-smoke.ts \
 *     --tools sparql-only --run-suffix smoke-ds-001
 *
 *   # Run 2 — both wazoo tools (search + sparql)
 *   bun --env-file=.env.local run scripts/worlds-agent-smoke.ts \
 *     --tools search+sparql --run-suffix smoke-ds-001
 *
 * Other flags: --model <alias> (default deepseek-v4-flash), --judge <alias>
 * (default deepseek-v4-flash), --limit <n> (default 5), --max-steps <n>
 * (default 8), --check-only, --replay <path>, --trace-id <suffix>.
 */
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { generateText, stepCountIs, tool } from "ai";
import { z } from "zod";
import type { WorldsSdkInterface } from "@worlds/sdk";
import { LoCoMoBenchmark } from "../src/benchmarks/locomo";
import { WorldsProvider } from "../src/providers/worlds";
import { config, getJudgeConfig } from "../src/utils/config";
import { getModelConfig, ModelConfig } from "../src/utils/models";
import { DeepSeekJudge } from "../src/judges/deepseek";
import { logger } from "../src/utils/logger";

const DEFAULT_RUN_SUFFIX = "smoke-ds-001";
const DEFAULT_MODEL = "deepseek-v4-flash";
const DEFAULT_JUDGE = "deepseek-v4-flash";
const DEFAULT_TOOLS = "search+sparql";
const TRACE_DIR = join(process.cwd(), "data", "agent-traces");

type ToolsMode = "sparql-only" | "search+sparql";

const SCHEMA_REFERENCE = `SPARQL Graph Schema & Multi-Hop Traversal:
- Pre-declared Prefixes (you may use these without declaring):
  schema: <http://schema.org/>
  rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
  rdfs: <http://www.w3.org/2000/01/rdf-schema#>
  xsd: <http://www.w3.org/2001/XMLSchema#>

- NOT pre-declared — declare them at the top of EVERY query that uses them:
  PREFIX prov: <http://www.w3.org/ns/prov#>
  PREFIX worlds: <https://worlds.wazoo.dev/ns/memory#>

- Key Domain Entity Classes & Predicates:
  schema:Person — schema:name, schema:knows, schema:worksFor, schema:hasOccupation, prov:wasDerivedFrom
  schema:Organization — schema:name
  schema:Event — schema:name, schema:about, schema:text, schema:eventStatus (schema:EventPostponed, schema:EventScheduled), schema:startDate, schema:location, prov:wasDerivedFrom
  schema:Action — schema:name, schema:agent, schema:object, schema:text, prov:wasDerivedFrom
  schema:MedicalCondition — schema:name, schema:about, schema:text, prov:wasDerivedFrom
  worlds:Claim — worlds:claimSubject, worlds:claimAction, worlds:claimObject, worlds:claimText, schema:about, prov:wasDerivedFrom
  schema:Conversation / schema:Message — schema:hasPart, schema:text, schema:position, schema:author, schema:creator

- Multi-Hop SPARQL Query Examples (always include the two PREFIX lines when using prov:/worlds:):
  * Person-to-Organization employment:
    PREFIX prov: <http://www.w3.org/ns/prov#>
    PREFIX worlds: <https://worlds.wazoo.dev/ns/memory#>
    SELECT ?personName ?orgName WHERE { ?p a schema:Person ; schema:name ?personName ; schema:worksFor ?org . ?org schema:name ?orgName . }
  * Inter-Person relationships:
    PREFIX prov: <http://www.w3.org/ns/prov#>
    PREFIX worlds: <https://worlds.wazoo.dev/ns/memory#>
    SELECT ?p1Name ?p2Name WHERE { ?p1 a schema:Person ; schema:name ?p1Name ; schema:knows ?p2 . ?p2 schema:name ?p2Name . }
  * Events & Actions about a Person:
    PREFIX prov: <http://www.w3.org/ns/prov#>
    PREFIX worlds: <https://worlds.wazoo.dev/ns/memory#>
    SELECT ?personName ?eventName ?status ?date WHERE { ?e a schema:Event ; schema:name ?eventName ; schema:about ?p . ?p schema:name ?personName . OPTIONAL { ?e schema:eventStatus ?status } OPTIONAL { ?e schema:startDate ?date } }
  * Claims & Medical Conditions about an Entity:
    PREFIX prov: <http://www.w3.org/ns/prov#>
    PREFIX worlds: <https://worlds.wazoo.dev/ns/memory#>
    SELECT ?entityName ?claimText WHERE { ?c a worlds:Claim ; worlds:claimText ?claimText ; schema:about ?e . ?e schema:name ?entityName . }
  * Temporal facts live on worlds:Claim via worlds:claimWhen (or schema:startDate) — e.g. "Melanie painted a lake sunrise painting last year" is a claim with claimWhen 2022:
    PREFIX prov: <http://www.w3.org/ns/prov#>
    PREFIX worlds: <https://worlds.wazoo.dev/ns/memory#>
    SELECT ?claimText ?when WHERE { ?c a worlds:Claim ; worlds:claimText ?claimText . OPTIONAL { ?c worlds:claimWhen ?when } . FILTER(CONTAINS(LCASE(?claimText), "sunrise")) } LIMIT 5

Rules:
- Use Session Date on results for temporal questions.
- Cite evidence from tool results; do not invent facts.
- Always include LIMIT (≤ 20) in SPARQL SELECT queries.
- When you have enough evidence, answer concisely in plain text (no tool calls).`;

function buildSparqlOnlySystemPrompt(): string {
  return `You answer questions about a long conversation stored in a Worlds knowledge graph. Your ONLY tool is worlds_sparql — you must retrieve all evidence by writing SPARQL queries against the graph. There is no keyword search tool.

${SCHEMA_REFERENCE}

SPARQL-only strategy:
- Start by discovering what is in the graph if you are unsure of the schema:
  SELECT ?type (COUNT(*) AS ?n) WHERE { ?s a ?type } GROUP BY ?type ORDER BY DESC(?n) LIMIT 20
- Then drill in: find the entities the question names (schema:name CONTAINS matches), and traverse predicates across hops.
- Break the question into entity + relation steps and chain them in one query (or a few).
- For temporal questions, join through schema:dateCreated on the session (prov:wasDerivedFrom) or schema:startDate on events/claims.

Remember: you MUST use worlds_sparql to gather evidence before answering.`;
}

function buildSearchSparqlSystemPrompt(): string {
  return `You answer questions about a long conversation stored in a Worlds knowledge graph.

Tool order:
1. worlds_search — default first step. Use short keywords and proper names, not full sentences.
2. worlds_sparql — use when you need multi-hop domain graph traversal (across entities, organizations, events, actions, medical conditions) or structured SPARQL queries.

${SCHEMA_REFERENCE}`;
}

type TraceRecord = {
  questionId: string;
  question: string;
  questionType?: string;
  containerTag: string;
  groundTruth?: string;
  toolsMode: ToolsMode;
  model: string;
  startedAt: string;
  finishedAt?: string;
  error?: string;
  finalText?: string;
  judgeLabel?: string;
  judgeScore?: number;
  judgeExplanation?: string;
  steps?: unknown[];
  toolCalls?: unknown[];
  inputTokens?: number;
  outputTokens?: number;
  replayed?: boolean;
};

interface PlainTool {
  name: string;
  description: string;
  zodSchema: z.ZodObject<Record<string, z.ZodTypeAny>>;
  jsonSchema: Record<string, unknown>;
  execute: (args: Record<string, unknown>) => Promise<unknown>;
}

function parseArgs(argv: string[]) {
  const checkOnly = argv.includes("--check-only");
  const replayIdx = argv.indexOf("--replay");
  const replayPath = replayIdx >= 0 ? argv[replayIdx + 1] : undefined;
  const suffixIdx = argv.indexOf("--run-suffix");
  const runSuffix = suffixIdx >= 0 ? argv[suffixIdx + 1]! : DEFAULT_RUN_SUFFIX;
  const limitIdx = argv.indexOf("--limit");
  const limit = limitIdx >= 0 ? parseInt(argv[limitIdx + 1]!, 10) : 5;
  const modelIdx = argv.indexOf("--model");
  const model = modelIdx >= 0 ? argv[modelIdx + 1]! : DEFAULT_MODEL;
  const judgeIdx = argv.indexOf("--judge");
  const judge = judgeIdx >= 0 ? argv[judgeIdx + 1]! : DEFAULT_JUDGE;
  const toolsIdx = argv.indexOf("--tools");
  const toolsRaw = toolsIdx >= 0 ? argv[toolsIdx + 1]! : DEFAULT_TOOLS;
  const toolsMode: ToolsMode = toolsRaw === "sparql-only"
    ? "sparql-only"
    : "search+sparql";
  const maxStepsIdx = argv.indexOf("--max-steps");
  const maxSteps = maxStepsIdx >= 0 ? parseInt(argv[maxStepsIdx + 1]!, 10) : 8;
  const traceIdIdx = argv.indexOf("--trace-id");
  const traceId = traceIdIdx >= 0 ? argv[traceIdIdx + 1] : undefined;
  return {
    checkOnly,
    replayPath,
    runSuffix,
    limit,
    model,
    judge,
    toolsMode,
    maxSteps,
    traceId,
  };
}

function createModel(modelAlias: string): {
  model: ReturnType<ReturnType<typeof createOpenAI>>;
  modelConfig: ModelConfig;
  providerOptions?: Record<string, unknown>;
} {
  const modelConfig = getModelConfig(modelAlias);
  switch (modelConfig.provider) {
    case "google":
      return {
        model: createGoogleGenerativeAI({ apiKey: config.googleApiKey })(
          modelConfig.id,
        ) as unknown as ReturnType<ReturnType<typeof createOpenAI>>,
        modelConfig,
      };
    case "deepseek":
      return {
        model: createOpenAI({
          apiKey: config.deepseekApiKey,
          baseURL: config.deepseekBaseUrl,
        })(modelConfig.id),
        modelConfig,
      };
    default:
      throw new Error(
        `Unsupported model provider for agent smoke: ${modelConfig.provider}`,
      );
  }
}

async function checkBilling(modelAlias: string): Promise<void> {
  const { model } = createModel(modelAlias);
  await generateText({
    model,
    prompt: "Reply with exactly: ok",
    maxOutputTokens: 8,
  });
  logger.success(`Billing check passed (${modelAlias})`);
}

function buildPlainTools(
  getClient: () => Promise<WorldsSdkInterface>,
  provider: WorldsProvider,
  containerTag: string,
  toolsMode: ToolsMode,
  traceSink: (entry: Record<string, unknown>) => void,
): PlainTool[] {
  const tools: PlainTool[] = [];

  if (toolsMode === "search+sparql") {
    tools.push({
      name: "worlds_search",
      description:
        "Hybrid keyword + vector search over conversation messages. Use first. " +
        'Query: short keywords and person names (e.g. "Caroline LGBTQ support group"). ' +
        "Returns messages with Session Date, Speaker, and relevance score when available.",
      zodSchema: z.object({
        query: z.string().describe(
          "Short search query with names and keywords",
        ),
      }),
      jsonSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Short search query with names and keywords",
          },
        },
        required: ["query"],
      },
      execute: async (args) => {
        const started = Date.now();
        const results = await provider.search(String(args.query), {
          containerTag,
        });
        // Cap the payload: the model only needs the top hits, and a 100-result
        // blob previously triggered a socket-closed error on the next API call.
        const payload = {
          resultCount: results.length,
          results: results.slice(0, 10),
        };
        return payload;
      },
    });
  }

  tools.push({
    name: "worlds_sparql",
    description:
      "Run a read-only SPARQL SELECT query on the RDF graph. Performs multi-hop domain graph traversal over " +
      "schema:Person, schema:Event, schema:Action, schema:Organization, schema:MedicalCondition, and worlds:Claim nodes " +
      "using predicates schema:knows, schema:worksFor, schema:about, schema:eventStatus, schema:agent, and prov:wasDerivedFrom. " +
      "Always include LIMIT (≤ 20). Prefixes schema:, prov:, worlds:, rdf:, rdfs: are pre-declared.",
    zodSchema: z.object({
      query: z.string().describe("SPARQL SELECT query, LIMIT ≤ 20"),
    }),
    jsonSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "SPARQL SELECT query, LIMIT ≤ 20",
        },
      },
      required: ["query"],
    },
    execute: async (args) => {
      const started = Date.now();
      const client = await getClient();
      const response = await client.sparql({ query: String(args.query) });
      const payload = response.kind === "select"
        ? {
          kind: response.kind,
          bindings: response.data.results.bindings.slice(0, 20),
          totalBindings: response.data.results.bindings.length,
        }
        : { kind: response.kind, response };
      return payload;
    },
  });

  return tools;
}

function toAiSdkTools(
  plainTools: PlainTool[],
): Record<string, ReturnType<typeof tool>> {
  const out: Record<string, ReturnType<typeof tool>> = {};
  for (const t of plainTools) {
    out[t.name] = tool({
      description: t.description,
      inputSchema: t.zodSchema,
      execute: (args) => t.execute(args as Record<string, unknown>),
    });
  }
  return out;
}

function toOpenAiTools(plainTools: PlainTool[]) {
  return plainTools.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.jsonSchema,
    },
  }));
}

/**
 * Raw /chat/completions agent loop for DeepSeek. The AI SDK OpenAI provider
 * fails to round-trip DeepSeek tool calls, so we drive the loop directly:
 * send tools, execute any returned tool calls, append assistant + tool
 * messages, repeat until the model answers without tool calls or steps run
 * out. Usage is accumulated across calls.
 */
async function runDeepSeekAgentLoop(opts: {
  modelId: string;
  system: string;
  prompt: string;
  tools: PlainTool[];
  maxSteps: number;
  maxTokens?: number;
  onToolCall: (tc: {
    name: string;
    args: Record<string, unknown>;
    ms: number;
    result: unknown;
  }) => void;
}): Promise<
  { text: string; inputTokens: number; outputTokens: number; steps: number }
> {
  const messages: Record<string, unknown>[] = [
    { role: "system", content: opts.system },
    { role: "user", content: opts.prompt },
  ];
  const openaiTools = toOpenAiTools(opts.tools);
  const toolByName = new Map(opts.tools.map((t) => [t.name, t]));
  const baseUrl = (config.deepseekBaseUrl || "https://api.deepseek.com")
    .replace(/\/$/, "");
  const url = `${baseUrl}/chat/completions`;

  let inputTokens = 0;
  let outputTokens = 0;
  let lastText = "";

  const call = async (): Promise<{
    message: Record<string, any>;
    finishReason: string;
    usage: { prompt_tokens?: number; completion_tokens?: number };
  }> => {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.deepseekApiKey}`,
      },
      body: JSON.stringify({
        model: opts.modelId,
        messages,
        tools: openaiTools,
        tool_choice: "auto",
        max_tokens: opts.maxTokens ?? 4096,
        // deepseek-v4-flash is a reasoning model; disable thinking so the
        // tool loop is fast and output budget is not burned on reasoning.
        thinking: { type: "disabled" },
        stream: false,
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(
        `DeepSeek agent loop HTTP ${res.status}: ${
          JSON.stringify(data).slice(0, 400)
        }`,
      );
    }
    const choice = data.choices?.[0];
    if (!choice) {
      throw new Error(
        `DeepSeek agent loop: no choice in response: ${
          JSON.stringify(data).slice(0, 400)
        }`,
      );
    }
    return {
      message: choice.message ?? {},
      finishReason: choice.finish_reason ?? "",
      usage: data.usage ?? {},
    };
  };

  for (let step = 0; step < opts.maxSteps; step++) {
    const { message, finishReason, usage } = await call();
    inputTokens += usage.prompt_tokens ?? 0;
    outputTokens += usage.completion_tokens ?? 0;
    lastText = typeof message.content === "string" ? message.content : "";

    const toolCalls: Array<
      { id: string; name: string; args: Record<string, unknown> }
    > = [];
    for (const tc of message.tool_calls ?? []) {
      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(tc.function?.arguments ?? "{}");
      } catch {
        parsed = {};
      }
      toolCalls.push({
        id: tc.id,
        name: tc.function?.name ?? "",
        args: parsed,
      });
    }

    if (toolCalls.length === 0) {
      // Model answered without tools (finish_reason "stop" or exhausted).
      return { text: lastText, inputTokens, outputTokens, steps: step + 1 };
    }

    messages.push({
      role: "assistant",
      content: message.content ?? null,
      tool_calls: message.tool_calls,
    });

    for (const tc of toolCalls) {
      const t = toolByName.get(tc.name);
      if (!t) {
        messages.push({
          role: "tool",
          tool_call_id: tc.id,
          content: JSON.stringify({
            success: false,
            error: `Unknown tool: ${tc.name}`,
          }),
        });
        continue;
      }
      const started = Date.now();
      let result: unknown;
      try {
        result = await t.execute(tc.args);
      } catch (err) {
        result = {
          success: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
      const ms = Date.now() - started;
      opts.onToolCall({ name: tc.name, args: tc.args, ms, result });
      messages.push({
        role: "tool",
        tool_call_id: tc.id,
        content: JSON.stringify(result),
      });
    }
  }

  return { text: lastText, inputTokens, outputTokens, steps: opts.maxSteps };
}

async function loadQuestions(
  limit: number,
): Promise<
  Array<
    {
      questionId: string;
      question: string;
      questionType: string;
      groundTruth: string;
    }
  >
> {
  const benchmark = new LoCoMoBenchmark();
  await benchmark.load();
  return benchmark
    .getQuestions()
    .filter((q) => /^conv-26-q\d+$/.test(q.questionId))
    .slice(0, limit)
    .map((q) => ({
      questionId: q.questionId,
      question: q.question,
      questionType: q.questionType,
      groundTruth: benchmark.getGroundTruth(q.questionId),
    }));
}

async function runAgentForQuestion(opts: {
  modelAlias: string;
  judge: DeepSeekJudge | null;
  provider: WorldsProvider;
  getClient: () => Promise<WorldsSdkInterface>;
  questionId: string;
  question: string;
  questionType: string;
  containerTag: string;
  groundTruth?: string;
  toolsMode: ToolsMode;
  maxSteps: number;
  tracePath: string;
}): Promise<TraceRecord> {
  const record: TraceRecord = {
    questionId: opts.questionId,
    question: opts.question,
    questionType: opts.questionType,
    containerTag: opts.containerTag,
    groundTruth: opts.groundTruth,
    toolsMode: opts.toolsMode,
    model: opts.modelAlias,
    startedAt: new Date().toISOString(),
  };

  const toolTrace: Record<string, unknown>[] = [];
  const plainTools = buildPlainTools(
    opts.getClient,
    opts.provider,
    opts.containerTag,
    opts.toolsMode,
    (e) => toolTrace.push(e),
  );
  const modelConfig = getModelConfig(opts.modelAlias);
  const systemPrompt = opts.toolsMode === "sparql-only"
    ? buildSparqlOnlySystemPrompt()
    : buildSearchSparqlSystemPrompt();

  try {
    let finalText = "";
    let inputTokens = 0;
    let outputTokens = 0;
    let steps = 0;

    if (modelConfig.provider === "deepseek") {
      const loop = await runDeepSeekAgentLoop({
        modelId: modelConfig.id,
        system: systemPrompt,
        prompt: opts.question,
        tools: plainTools,
        maxSteps: opts.maxSteps,
        onToolCall: (tc) => {
          const entry = {
            tool: tc.name,
            args: tc.args,
            ms: tc.ms,
            result: tc.result,
          };
          toolTrace.push(entry as unknown as Record<string, unknown>);
        },
      });
      finalText = loop.text;
      inputTokens = loop.inputTokens;
      outputTokens = loop.outputTokens;
      steps = loop.steps;
    } else {
      const { model, providerOptions } = createModel(opts.modelAlias);
      const result = await generateText({
        model,
        system: systemPrompt,
        prompt: opts.question,
        tools: toAiSdkTools(plainTools),
        stopWhen: stepCountIs(opts.maxSteps),
        ...(providerOptions ? { providerOptions } : {}),
        onStepFinish: (step) => {
          record.steps = [...(record.steps ?? []), step];
        },
      });
      finalText = result.text;
      const usage = (
        result as unknown as {
          usage?: { inputTokens?: number; outputTokens?: number };
        }
      ).usage;
      inputTokens = usage?.inputTokens ?? 0;
      outputTokens = usage?.outputTokens ?? 0;
      steps = record.steps?.length ?? 0;
    }

    record.finalText = finalText;
    record.toolCalls = toolTrace;
    record.steps = [...(record.steps ?? []), {
      loopSteps: steps,
      toolCalls: toolTrace.length,
    }];
    record.inputTokens = inputTokens;
    record.outputTokens = outputTokens;
    record.finishedAt = new Date().toISOString();

    if (opts.judge && opts.groundTruth) {
      try {
        const jr = await opts.judge.evaluate({
          question: opts.question,
          questionType: opts.questionType,
          groundTruth: opts.groundTruth,
          hypothesis: finalText,
        });
        record.judgeLabel = jr.label;
        record.judgeScore = jr.score;
        record.judgeExplanation = jr.explanation;
      } catch (err) {
        logger.warn(`[${opts.questionId}] judge failed: ${err}`);
      }
    }

    await appendFile(opts.tracePath, `${JSON.stringify(record)}\n`);
    return record;
  } catch (err) {
    record.error = String(err);
    record.toolCalls = toolTrace;
    record.finishedAt = new Date().toISOString();
    await appendFile(opts.tracePath, `${JSON.stringify(record)}\n`);
    throw err;
  }
}

async function main() {
  const {
    checkOnly,
    replayPath,
    runSuffix,
    limit,
    model,
    judge,
    toolsMode,
    maxSteps,
    traceId,
  } = parseArgs(process.argv.slice(2));

  if (checkOnly) {
    await checkBilling(model);
    return;
  }

  if (replayPath) {
    logger.info(
      `Replay mode: ${replayPath} (LLM-only re-run not yet wired — use live run to capture traces)`,
    );
    return;
  }

  await mkdir(TRACE_DIR, { recursive: true });
  const runId = `agent-${toolsMode}-${runSuffix}-${
    new Date().toISOString().replace(/[:.]/g, "-")
  }`;
  const tracePath = join(TRACE_DIR, `${traceId ? traceId : runId}.jsonl`);
  const latestPath = join(TRACE_DIR, "latest.jsonl");

  await checkBilling(model);

  const judgeInstance = await (async () => {
    const j = new DeepSeekJudge();
    await j.initialize({ ...getJudgeConfig("deepseek"), model: judge });
    return j;
  })();

  const provider = new WorldsProvider();
  await provider.initialize({
    apiKey: config.googleApiKey || config.deepseekApiKey,
  });

  const getClient = (containerTag: string) =>
    provider.getClientForContainer(containerTag);

  const questions = await loadQuestions(limit);
  logger.info(
    `Running ${questions.length} agent questions (tools: ${toolsMode}, model: ${model}, judge: ${judge}) → ${tracePath}`,
  );

  let ok = 0;
  const results: TraceRecord[] = [];
  for (const q of questions) {
    const containerTag = `${q.questionId}-${runSuffix}`;
    logger.info(
      `[${q.questionId}] ${q.question.slice(0, 60)}… (${containerTag})`,
    );
    try {
      const record = await runAgentForQuestion({
        modelAlias: model,
        judge: judgeInstance,
        provider,
        getClient: () => getClient(containerTag),
        questionId: q.questionId,
        question: q.question,
        questionType: q.questionType,
        containerTag,
        groundTruth: q.groundTruth,
        toolsMode,
        maxSteps,
        tracePath,
      });
      results.push(record);
      ok++;
      logger.success(`[${q.questionId}] ${record.judgeLabel ?? "no-judge"}`);
    } catch (err) {
      logger.error(`[${q.questionId}] failed: ${err}`);
      results.push({
        questionId: q.questionId,
        question: q.question,
        questionType: q.questionType,
        containerTag,
        groundTruth: q.groundTruth,
        toolsMode,
        model,
        startedAt: new Date().toISOString(),
        error: String(err),
      });
      break;
    }
  }

  await writeFile(latestPath, await readFile(tracePath, "utf8"));

  const summary = {
    runId,
    toolsMode,
    model,
    judge,
    runSuffix,
    completed: ok,
    total: questions.length,
    results,
  };
  const summaryPath = join(
    TRACE_DIR,
    `summary-${traceId ? traceId : runId}.json`,
  );
  await writeFile(summaryPath, JSON.stringify(summary, null, 2));

  const correct = results.filter((r) => r.judgeLabel === "correct").length;
  logger.info(`Traces: ${tracePath} (also ${latestPath})`);
  logger.info(`Summary: ${summaryPath}`);
  logger.info(
    `Completed ${ok}/${questions.length} | judge correct ${correct}/${results.length}`,
  );
}

main().catch((err) => {
  logger.error(String(err));
  process.exit(1);
});
