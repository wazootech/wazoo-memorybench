import { createHash } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { createGoogleGenerativeAI } from "@ai-sdk/google"
import { createOpenAI } from "@ai-sdk/openai"
import { generateText } from "ai"
import type { UnifiedSession } from "../../types/unified"
import { PROV, RDF, SCHEMA, TURTLE_PREFIXES, WORLDS } from "./ontology"
import { validateShaclGraph } from "./shapes"
import { sanitizePathSegment } from "./cache-path"
import { logger } from "../../utils/logger"

const EXTRACTION_MODEL = "gemini-2.5-flash"
const EXTRACTION_MAX_RETRIES = 6
const EXTRACTION_BASE_DELAY_MS = 4000

const GEMINI_QUOTA_WINDOW_MS = 60_000
const GEMINI_MAX_RPM = 18 // Keep under 20 RPM free tier cap
const geminiTimestamps: number[] = []

async function waitForGeminiQuota(): Promise<void> {
  const now = Date.now()
  while (geminiTimestamps.length > 0 && geminiTimestamps[0] < now - GEMINI_QUOTA_WINDOW_MS) {
    geminiTimestamps.shift()
  }
  if (geminiTimestamps.length >= GEMINI_MAX_RPM) {
    const oldest = geminiTimestamps[0] ?? now
    const waitMs = oldest + GEMINI_QUOTA_WINDOW_MS - now + 1000
    logger.debug(
      `Gemini rate limiter: ${geminiTimestamps.length}/${GEMINI_MAX_RPM} RPM used, pacing ${(
        waitMs / 1000
      ).toFixed(1)}s`
    )
    await new Promise((resolve) => setTimeout(resolve, waitMs))
    return waitForGeminiQuota()
  }
  geminiTimestamps.push(Date.now())
}

import { buildDomainRdfExtractionPrompt } from "../../prompts/extraction"
import { DeepSeekClient } from "../../utils/deepseek-client"

const CLAIM_TYPE_MAP: Record<string, string> = {
  fact: WORLDS.FactClaim,
  event: WORLDS.EventClaim,
  preference: WORLDS.PreferenceClaim,
  relationship: WORLDS.RelationshipClaim,
  plan: WORLDS.PlanClaim,
  // A claim about a person (job, skill, location, age) is a fact about that
  // person, not the schema:Person entity itself. Typing the claim node
  // schema:Person would trip PERSON_SHAPE, which demands schema:name. Keep
  // schema classes out of this map: dedicated branches above emit the real
  // schema nodes (Event/Action/MedicalCondition/Organization), and anything
  // else reaching the claim branch must stay in the worlds:Claim hierarchy.
  Person: WORLDS.FactClaim,
}

export interface ExtractedClaim {
  domainClass?: string
  type?: string
  subject: string
  action?: string
  object?: string
  claimText: string
  when?: string
  where?: string
  status?: string
}

export interface ExtractFactsOptions {
  /** When set, successful extractions are cached under this directory. */
  cacheDir?: string
  /** Model provider for extraction ('gemini' | 'openai' | 'ollama' | 'deepseek') */
  provider?: "gemini" | "openai" | "ollama" | "deepseek"
  baseUrl?: string
  model?: string
}

function resolveExtractionProvider(
  options?: ExtractFactsOptions
): "gemini" | "openai" | "ollama" | "deepseek" {
  if (options?.provider) return options.provider
  return process.env.OPENAI_BASE_URL ? "ollama" : "gemini"
}

function resolveExtractionModel(
  provider: "gemini" | "openai" | "ollama" | "deepseek",
  options?: ExtractFactsOptions
): string {
  if (options?.model) return options.model
  if (provider === "gemini") return EXTRACTION_MODEL
  if (provider === "deepseek") {
    return process.env.EXTRACTION_MODEL || "deepseek-v4-flash"
  }
  return process.env.EXTRACTION_MODEL || "qwen2.5-coder:7b"
}

function sessionContentHash(session: UnifiedSession): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        sessionId: session.sessionId,
        messages: session.messages,
        metadata: session.metadata,
      })
    )
    .digest("hex")
}

function buildFactExtractionPrompt(session: UnifiedSession): string {
  return buildDomainRdfExtractionPrompt(session)
}

function escapeTurtle(value: string | undefined | null): string {
  if (value === undefined || value === null) return ""
  return String(value)
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t")
}

function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "entity"
  )
}

/**
 * Content-based claim dedupe: claims with the same normalized claimText are
 * the same assertion, so only the first occurrence survives the graph build.
 * Without this, a model that emits one assertion twice (e.g. once as a
 * FactClaim and once as a plain Claim) produces duplicate claim nodes under
 * different URNs.
 */
export function dedupeClaims(claims: ExtractedClaim[]): ExtractedClaim[] {
  const seen = new Set<string>()
  const kept: ExtractedClaim[] = []
  for (const c of claims) {
    const key = c.claimText
      .trim()
      .toLowerCase()
      .replace(/\s+/g, " ")
      .replace(/[.!?!]+$/, "")
    if (seen.has(key)) continue
    seen.add(key)
    kept.push(c)
  }
  return kept
}

/**
 * Converts extracted claims into domain-driven RDF Turtle quads linked to their source session.
 * Constructs direct entity nodes (schema:Person, schema:Event, schema:Action, schema:MedicalCondition),
 * predicate assertions, schema:text summaries, and PROV-O provenance.
 *
 * The subject node is only typed schema:Person when the subject actually is
 * the person the claim is about. Event claims whose subject names the event
 * or venue itself (subject == where), Organization claims whose subject is
 * the organization name, and MedicalCondition claims whose subject is the
 * condition name get the entity node alone — minting a urn:person:/
 * schema:Person node for them leaked orgs and events into the person class.
 *
 * URN allocation: claim nodes are urn:claim:{sessionId}/{claimIndex} where
 * claimIndex is the claim's position in the deduped input array (gaps are
 * fine and expected — the index only disambiguates). Entities use
 * urn:person:|urn:org:|urn:event:|urn:medical:|urn:action: prefixes with a
 * name-derived slug; the session itself is urn:session:{sessionId}.
 *
 * The emitted Turtle is line-deduplicated: statements re-asserted by later
 * claims (an entity's schema:name/type quads) or repeated within a claim
 * (dual rdf:type typing) are emitted only once, so the serialized graph is
 * 1:1 with the deduplicated triple store.
 */
export function claimsToTurtle(claims: ExtractedClaim[], sessionId: string): string {
  if (claims.length === 0) return ""

  const sessionUri = `urn:session:${sessionId}`
  const lines: string[] = [TURTLE_PREFIXES, ""]
  // First-occurrence-wins dedupe of statement lines (applied at return time).
  const seen: Set<string> = new Set()

  for (let i = 0; i < claims.length; i++) {
    const c = claims[i]
    const domainClass = c.domainClass || c.type || "Fact"
    const subjectSlug = slugify(c.subject)
    const personUri = `urn:person:${sessionId}/${subjectSlug}`

    const isEvent = domainClass === "Event" || c.type === "event"
    // The organization's real name: its own object when the model supplied
    // one, otherwise the claim subject for Organization-domain claims. The
    // old `|| "Organization"` fallback leaked the class name into the graph
    // as a literal schema:name.
    const orgName = c.object || (domainClass === "Organization" ? c.subject : "")
    const isOrg =
      Boolean(orgName) &&
      (domainClass === "Organization" ||
        (c.action && /works for|employed at|company/i.test(c.action)))

    // URN for the claim node backing this assertion (the comment explaining
    // index semantics lives in the function docstring).
    const claimUri = `urn:claim:${sessionId}/${i}`

    // The subject names the entity the claim is about rather than a person
    // actor: an Event whose subject is the venue/event itself, an
    // Organization claim whose subject is the org name, or a
    // MedicalCondition whose subject is the condition name.
    const subjectIsItsOwnEntity =
      (isEvent && Boolean(c.where) && subjectSlug === slugify(c.where!)) ||
      (isOrg && subjectSlug === slugify(orgName)) ||
      (domainClass === "MedicalCondition" && Boolean(c.object) && subjectSlug === slugify(c.object!))

    lines.push(`# Assertions for ${c.subject} (${domainClass})`)
    if (!subjectIsItsOwnEntity) {
      lines.push(`<${personUri}> <${RDF.type}> <${SCHEMA.Person}> .`)
      lines.push(`<${personUri}> <${SCHEMA.name}> "${escapeTurtle(c.subject)}" .`)
    }

    if (isEvent) {
      const eventUri = `urn:event:${sessionId}/${i}`
      lines.push(
        `<${eventUri}> <${RDF.type}> <${SCHEMA.Event}> .`,
        `<${eventUri}> <${SCHEMA.name}> "${escapeTurtle(c.claimText)}" .`,
        `<${eventUri}> <${SCHEMA.text}> "${escapeTurtle(c.claimText)}" .`,
        `<${eventUri}> <${WORLDS.claimText}> "${escapeTurtle(c.claimText)}" .`,
        `<${eventUri}> <${PROV.wasDerivedFrom}> <${sessionUri}> .`
      )
      if (!subjectIsItsOwnEntity) {
        lines.push(`<${eventUri}> <${SCHEMA.about}> <${personUri}> .`)
      }
      if (c.status?.toLowerCase() === "postponed") {
        lines.push(`<${eventUri}> <${SCHEMA.eventStatus}> <${SCHEMA.EventPostponed}> .`)
      } else if (c.status?.toLowerCase() === "scheduled") {
        lines.push(`<${eventUri}> <${SCHEMA.eventStatus}> <${SCHEMA.EventScheduled}> .`)
      } else if (c.status?.toLowerCase() === "superseded") {
        lines.push(`<${eventUri}> <${WORLDS.status}> <${WORLDS.Superseded}> .`)
      }
      if (c.when) {
        lines.push(`<${eventUri}> <${SCHEMA.startDate}> "${escapeTurtle(c.when)}" .`)
      }
      if (c.where) {
        lines.push(`<${eventUri}> <${SCHEMA.location}> "${escapeTurtle(c.where)}" .`)
      }
    } else if (domainClass === "MedicalCondition") {
      const condUri = `urn:medical:${sessionId}/${i}`
      lines.push(
        `<${condUri}> <${RDF.type}> <${SCHEMA.MedicalCondition}> .`,
        `<${condUri}> <${SCHEMA.name}> "${escapeTurtle(c.object || c.action || c.claimText)}" .`,
        `<${condUri}> <${SCHEMA.about}> <${personUri}> .`,
        `<${condUri}> <${SCHEMA.text}> "${escapeTurtle(c.claimText)}" .`,
        `<${condUri}> <${WORLDS.claimText}> "${escapeTurtle(c.claimText)}" .`,
        `<${condUri}> <${PROV.wasDerivedFrom}> <${sessionUri}> .`
      )
    } else if (domainClass === "Action") {
      const actionUri = `urn:action:${sessionId}/${i}`
      lines.push(
        `<${actionUri}> <${RDF.type}> <${SCHEMA.Action}> .`,
        `<${actionUri}> <${SCHEMA.name}> "${escapeTurtle(c.action || c.claimText)}" .`,
        `<${actionUri}> <${SCHEMA.agent}> <${personUri}> .`,
        `<${actionUri}> <${SCHEMA.text}> "${escapeTurtle(c.claimText)}" .`,
        `<${actionUri}> <${WORLDS.claimText}> "${escapeTurtle(c.claimText)}" .`,
        `<${actionUri}> <${PROV.wasDerivedFrom}> <${sessionUri}> .`
      )
      if (c.object) {
        lines.push(`<${actionUri}> <${SCHEMA.object}> "${escapeTurtle(c.object)}" .`)
      }
    } else if (isOrg) {
      const orgUri = `urn:org:${sessionId}/${slugify(orgName)}`
      lines.push(
        `<${orgUri}> <${RDF.type}> <${SCHEMA.Organization}> .`,
        `<${orgUri}> <${SCHEMA.name}> "${escapeTurtle(orgName)}" .`,
        `<${orgUri}> <${PROV.wasDerivedFrom}> <${sessionUri}> .`
      )
      if (!subjectIsItsOwnEntity) {
        lines.push(`<${personUri}> <${SCHEMA.worksFor}> <${orgUri}> .`)
      }
      // The employment assertion gets a claim node like every other claim —
      // same URN scheme, same worlds:Claim typing, same provenance — instead
      // of claimText literals dangling off the person/org entity node.
      lines.push(
        `<${claimUri}> <${RDF.type}> <${WORLDS.Claim}> .`,
        `<${claimUri}> <${SCHEMA.about}> <${subjectIsItsOwnEntity ? orgUri : personUri}> .`,
        `<${claimUri}> <${SCHEMA.text}> "${escapeTurtle(c.claimText)}" .`,
        `<${claimUri}> <${WORLDS.claimText}> "${escapeTurtle(c.claimText)}" .`,
        `<${claimUri}> <${PROV.wasDerivedFrom}> <${sessionUri}> .`
      )
      if (c.action) {
        lines.push(`<${claimUri}> <${WORLDS.claimAction}> "${escapeTurtle(c.action)}" .`)
      }
      if (c.object && !subjectIsItsOwnEntity) {
        lines.push(`<${claimUri}> <${WORLDS.claimObject}> "${escapeTurtle(c.object)}" .`)
      }
    } else {
      const typeIri = CLAIM_TYPE_MAP[c.type || domainClass] || WORLDS.Claim
      // Both types are load-bearing: n3 does no subclass inference, so a
      // "?x rdf:type worlds:Claim" query must also match FactClaim nodes.
      // The emitted-line dedupe below collapses the two when they are equal.
      lines.push(
        `<${claimUri}> <${RDF.type}> <${typeIri}> .`,
        `<${claimUri}> <${RDF.type}> <${WORLDS.Claim}> .`,
        `<${claimUri}> <${SCHEMA.about}> <${personUri}> .`,
        `<${claimUri}> <${SCHEMA.text}> "${escapeTurtle(c.claimText)}" .`,
        `<${claimUri}> <${WORLDS.claimText}> "${escapeTurtle(c.claimText)}" .`,
        `<${claimUri}> <${WORLDS.claimSubject}> "${escapeTurtle(c.subject)}" .`,
        `<${claimUri}> <${PROV.wasDerivedFrom}> <${sessionUri}> .`
      )
      if (c.action) {
        lines.push(`<${claimUri}> <${WORLDS.claimAction}> "${escapeTurtle(c.action)}" .`)
      }
      if (c.object) {
        lines.push(`<${claimUri}> <${WORLDS.claimObject}> "${escapeTurtle(c.object)}" .`)
      }
      if (c.when) {
        lines.push(`<${claimUri}> <${SCHEMA.startDate}> "${escapeTurtle(c.when)}" .`)
      }
      if (c.where) {
        lines.push(`<${claimUri}> <${SCHEMA.location}> "${escapeTurtle(c.where)}" .`)
      }
    }
    lines.push("")
  }

  // First-occurrence-wins: entity name/type quads re-asserted by later
  // claims and within-claim repeats never reach the output twice.
  const dedupedLines = lines.filter((l) => {
    if (!l.startsWith("<")) return true // comments, prefixes, blanks
    if (seen.has(l)) return false
    seen.add(l)
    return true
  })
  return dedupedLines.join("\n")
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function generateExtractionJson(
  apiKey: string,
  session: UnifiedSession,
  options?: ExtractFactsOptions
): Promise<string> {
  const prompt = buildFactExtractionPrompt(session)
  const provider = resolveExtractionProvider(options)
  const model = resolveExtractionModel(provider, options)

  // DeepSeek extraction goes through the shared raw-fetch DeepSeekClient (not
  // the AI SDK) for full control: JSON output mode + thinking disabled make
  // the response deterministic and fast, and the response carries exact usage
  // telemetry. deepseek-v4-flash is a reasoning model — without
  // `thinking: {type:"disabled"}` the output budget is consumed by reasoning
  // tokens and calls run tens of seconds. A missing DEEPSEEK_API_KEY fails
  // fast in the client.
  if (provider === "deepseek") {
    const { text, usage } = await new DeepSeekClient().chatCompletion({
      model,
      prompt,
      maxTokens: 1500,
      temperature: 0,
      responseFormat: "json_object",
      thinking: "disabled",
    })
    if (usage) {
      logger.debug(
        `DeepSeek extraction usage: ${usage.promptTokens} in / ${usage.completionTokens} out`
      )
    }
    return text
  }

  const isOllamaOrOpenAI =
    provider === "ollama" ||
    provider === "openai" ||
    (provider !== "gemini" &&
      (options?.baseUrl ||
        process.env.EXTRACTION_BASE_URL ||
        process.env.OPENAI_BASE_URL ||
        !apiKey))

  const modelInstance = isOllamaOrOpenAI
    ? createOpenAI({
        apiKey: apiKey || process.env.OPENAI_API_KEY || "ollama",
        baseURL:
          options?.baseUrl ||
          process.env.EXTRACTION_BASE_URL ||
          process.env.OPENAI_BASE_URL ||
          "http://localhost:11434/v1",
      })(model)
    : createGoogleGenerativeAI({ apiKey })(model)

  let lastErr: unknown
  for (let attempt = 0; attempt < EXTRACTION_MAX_RETRIES; attempt++) {
    try {
      if (!isOllamaOrOpenAI) {
        await waitForGeminiQuota()
      }
      const { text } = await generateText({
        model: modelInstance,
        prompt,
        maxTokens: 4000,
        temperature: 0,
      } as Parameters<typeof generateText>[0])
      return text
    } catch (err) {
      lastErr = err
      const wait = EXTRACTION_BASE_DELAY_MS * 2 ** attempt
      logger.warn(
        `Fact extraction attempt ${
          attempt + 1
        }/${EXTRACTION_MAX_RETRIES} failed for ${session.sessionId}: ${err}. Retrying in ${wait}ms`
      )
      await sleep(wait)
    }
  }
  throw lastErr
}

/**
 * Extracts structured facts from a conversation session using Gemini or local Ollama,
 * then converts them to RDF Turtle triples.
 */
export async function extractFactsToTurtle(
  apiKey: string,
  session: UnifiedSession,
  options?: ExtractFactsOptions
): Promise<string> {
  const hash = sessionContentHash(session)
  const cacheDir = options?.cacheDir
  // Model-qualified key: {cacheDir}/{provider}/{model}/{hash}.json so a
  // provider/model swap misses instead of reusing stale extraction output.
  // Segments are sanitized for Windows: model tags like "qwen2.5-coder:7b"
  // contain ":", which is illegal in Windows dir names (see #48).
  const provider = resolveExtractionProvider(options)
  const model = resolveExtractionModel(provider, options)
  const cacheFile = cacheDir
    ? join(cacheDir, sanitizePathSegment(provider), sanitizePathSegment(model), `${hash}.json`)
    : undefined

  if (cacheFile) {
    try {
      const raw = await readFile(cacheFile, "utf-8")
      const cached = JSON.parse(raw) as { hash: string; turtle: string }
      if (cached.hash === hash && typeof cached.turtle === "string") {
        logger.debug(`Using cached fact extraction for ${session.sessionId}`)
        return cached.turtle
      }
    } catch {
      /* no cache */
    }
  }

  const text = await generateExtractionJson(apiKey, session, options)

  let claims: ExtractedClaim[]
  try {
    const cleaned = text
      .trim()
      .replace(/^```json?\s*/i, "")
      .replace(/```\s*$/, "")
    claims = JSON.parse(cleaned) as ExtractedClaim[]
    if (!Array.isArray(claims)) {
      logger.warn(`Fact extraction for ${session.sessionId}: response was not an array`)
      return ""
    }
  } catch (err) {
    logger.warn(`Fact extraction for ${session.sessionId}: failed to parse JSON: ${err}`)
    logger.debug(`Raw extraction response: ${text.slice(0, 500)}`)
    return ""
  }

  // The domain extraction prompt emits "domainClass" (the generic MEMORY
  // extraction path emits "type"); accept either so claims are not dropped.
  const valid = claims.filter(
    (c) => (c.type || c.domainClass) && c.subject && c.claimText && typeof c.claimText === "string"
  )
  const deduped = dedupeClaims(valid)
  if (deduped.length < valid.length) {
    logger.debug(
      `Deduped ${valid.length - deduped.length} duplicate claim(s) for session ${session.sessionId}`
    )
  }

  logger.debug(
    `Extracted ${deduped.length} claims from session ${session.sessionId} (${claims.length} raw)`
  )

  const turtle = claimsToTurtle(deduped, session.sessionId)

  if (turtle) {
    const shaclResult = await validateShaclGraph(turtle)
    if (!shaclResult.valid) {
      logger.warn(
        `SHACL Validation Violations for session ${session.sessionId}:\n` +
          shaclResult.errors.join("\n")
      )
    } else {
      logger.debug(`SHACL Validation Passed for session ${session.sessionId}`)
    }
  }

  if (cacheFile && turtle) {
    try {
      await mkdir(dirname(cacheFile), { recursive: true })
      await writeFile(cacheFile, JSON.stringify({ hash, turtle }), "utf-8")
    } catch (err) {
      logger.warn(`Failed to write extraction cache for ${session.sessionId}: ${err}`)
    }
  }

  return turtle
}
