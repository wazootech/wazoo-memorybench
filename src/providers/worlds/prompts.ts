import type { ProviderPrompts } from "../../types/prompts"

interface WorldsSearchResult {
  sessionId?: string
  text?: string
  score?: number
  subject?: string
  predicate?: string
  graph?: string
  sessionDate?: string
  speaker?: string
  speakerA?: string
  speakerB?: string
}

interface FactClaimContext {
  isClaim: true
  claimText: string
  claimType: string
  subject: string
  action: string
  object: string
  when?: string
  where?: string
  sessionUri?: string
  sessionDate?: string
}

function isFactClaim(r: unknown): r is FactClaimContext {
  return typeof r === "object" && r !== null && (r as Record<string, unknown>).isClaim === true
}

function buildFactsSection(claims: FactClaimContext[]): string {
  if (claims.length === 0) return ""

  const lines = claims.map((c, i) => {
    const parts: string[] = [`--- Fact ${i + 1} [${c.claimType}] ---`]
    if (c.sessionDate) parts.push(`Session Date: ${c.sessionDate}`)
    parts.push(`Claim: ${c.claimText}`)
    if (c.when) parts.push(`When: ${c.when}`)
    if (c.where) parts.push(`Where: ${c.where}`)
    return parts.join("\n")
  })

  return `\n\nStructured Facts (extracted from the knowledge graph):\n${lines.join("\n\n")}`
}

function buildWorldsContext(context: unknown[]): string {
  const claims: FactClaimContext[] = []
  const results: WorldsSearchResult[] = []

  for (const item of context) {
    if (isFactClaim(item)) {
      claims.push(item)
    } else {
      results.push(item as WorldsSearchResult)
    }
  }

  const searchSection =
    results.length === 0
      ? "(no search results retrieved)"
      : results
          .map((r, i) => {
            const lines: string[] = []
            const score = r.score != null ? ` [relevance: ${r.score.toFixed(3)}]` : ""
            lines.push(`--- Result ${i + 1}${score} ---`)
            if (r.sessionDate) lines.push(`Session Date: ${r.sessionDate}`)
            if (r.speaker) lines.push(`Speaker: ${r.speaker}`)
            if (r.speakerA || r.speakerB) {
              const participants = [r.speakerA, r.speakerB].filter(Boolean).join(" & ")
              lines.push(`Participants: ${participants}`)
            }
            lines.push(`Text: ${r.text?.trim() || "(empty)"}`)
            return lines.join("\n")
          })
          .join("\n\n")

  return searchSection + buildFactsSection(claims)
}

function buildWorldsAnswerPrompt(
  question: string,
  context: unknown[],
  questionDate?: string
): string {
  const retrievedContext = buildWorldsContext(context)

  return `You are a question-answering system with access to a conversational memory store. Answer the question using ONLY the retrieved context below.

Question: ${question}
Question Date: ${questionDate || "Not specified"}

Retrieved Context:
${retrievedContext}

**How to Answer:**

1. **Structured Facts**: Facts appear after the first batch of search results. Each fact may include a **Session Date** for the source conversation — use it for temporal reasoning the same way as message results.

2. **Search results**: Raw message excerpts include Session Date, Speaker, and Participants where available. Use them for nuance, quotes, and relative dates in dialogue ("yesterday" relative to Session Date).

3. **Temporal reasoning**: Each "Session Date" indicates when that conversation took place. Resolve relative time using that date (e.g. "yesterday" with Session Date May 8, 2023 → May 7, 2023). Use Question Date when interpreting the question itself.

4. **Speaker attribution**: Use Speaker and Participants on message results; facts use the claim wording (who did what).

5. **Synthesis**: Combine facts and messages — facts summarize; messages provide evidence and exact wording.

6. **Be inferential**: Answer when reasonably supported by context; do not default to "I don't know" if facts or messages support an answer.

7. **Only say "I don't know"** if nothing in the retrieved context supports an answer.

**Response Format:**
Think step by step, then provide your answer.

Reasoning:
[Your step-by-step reasoning process here]

Answer:
[Your final answer here]`
}

export const WORLDS_PROMPTS: ProviderPrompts = {
  answerPrompt: buildWorldsAnswerPrompt,
}
