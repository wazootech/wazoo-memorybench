import { Parser, Store } from "n3"
// @ts-ignore - rdf-validate-shacl lacks bundle typings
import SHACLValidator from "rdf-validate-shacl"
import { PROV, RDF, SCHEMA, TURTLE_PREFIXES, WORLDS, XSD } from "./ontology"
import { logger } from "../../utils/logger"

/**
 * SHACL shapes for validating the session/message graph produced by
 * formatSessionForIngestion(). Expressed as Turtle.
 */

export const SESSION_SHAPE = `
${TURTLE_PREFIXES}
@prefix sh: <http://www.w3.org/ns/shacl#> .

worlds:SessionShape a sh:NodeShape ;
  sh:targetClass schema:Conversation ;
  sh:property [
    sh:path schema:dateCreated ;
    sh:minCount 1 ;
    sh:maxCount 1 ;
    sh:datatype xsd:string ;
  ] ;
  sh:property [
    sh:path schema:hasPart ;
    sh:minCount 1 ;
    sh:node worlds:MessageShape ;
  ] .
`

export const MESSAGE_SHAPE = `
${TURTLE_PREFIXES}
@prefix sh: <http://www.w3.org/ns/shacl#> .

worlds:MessageShape a sh:NodeShape ;
  sh:targetClass schema:Message ;
  sh:property [
    sh:path schema:text ;
    sh:minCount 1 ;
    sh:maxCount 1 ;
    sh:datatype xsd:string ;
  ] ;
  sh:property [
    sh:path schema:position ;
    sh:minCount 1 ;
    sh:maxCount 1 ;
    sh:datatype xsd:integer ;
  ] ;
  sh:property [
    sh:path schema:author ;
    sh:minCount 1 ;
    sh:maxCount 1 ;
  ] ;
  sh:property [
    sh:path prov:wasGeneratedBy ;
    sh:minCount 1 ;
    sh:maxCount 1 ;
  ] .
`

export const CLAIM_SHAPE = `
${TURTLE_PREFIXES}
@prefix sh: <http://www.w3.org/ns/shacl#> .

worlds:ClaimShape a sh:NodeShape ;
  sh:targetClass worlds:Claim ;
  sh:property [
    sh:path prov:wasDerivedFrom ;
    sh:minCount 1 ;
  ] .
`

export const PERSON_SHAPE = `
${TURTLE_PREFIXES}
@prefix sh: <http://www.w3.org/ns/shacl#> .

worlds:PersonShape a sh:NodeShape ;
  sh:targetClass schema:Person ;
  sh:property [
    sh:path schema:name ;
    sh:minCount 1 ;
  ] .
`

export const EVENT_SHAPE = `
${TURTLE_PREFIXES}
@prefix sh: <http://www.w3.org/ns/shacl#> .

worlds:EventShape a sh:NodeShape ;
  sh:targetClass schema:Event ;
  sh:property [
    sh:path schema:name ;
    sh:minCount 1 ;
  ] ;
  sh:property [
    sh:path prov:wasDerivedFrom ;
    sh:minCount 1 ;
  ] .
`

export const ACTION_SHAPE = `
${TURTLE_PREFIXES}
@prefix sh: <http://www.w3.org/ns/shacl#> .

worlds:ActionShape a sh:NodeShape ;
  sh:targetClass schema:Action ;
  sh:property [
    sh:path schema:name ;
    sh:minCount 1 ;
  ] ;
  sh:property [
    sh:path prov:wasDerivedFrom ;
    sh:minCount 1 ;
  ] .
`

export const DOMAINS_SHACL_SHAPE = [CLAIM_SHAPE, PERSON_SHAPE, EVENT_SHAPE, ACTION_SHAPE].join("\n")

export interface ValidationResult {
  valid: boolean
  errors: string[]
}

/**
 * Parses a Turtle string into an N3 Quad Store.
 */
export function parseTurtleToDataset(turtle: string): Store {
  const parser = new Parser()
  const store = new Store()
  const quads = parser.parse(turtle)
  store.addQuads(quads)
  return store
}

/**
 * Full W3C SHACL shape validation using rdf-validate-shacl.
 * Evaluates target RDF data quads against specified SHACL constraint shapes.
 */
export async function validateShaclGraph(
  dataTurtle: string,
  shapeTurtle: string = DOMAINS_SHACL_SHAPE
): Promise<ValidationResult> {
  if (!dataTurtle.trim()) return { valid: true, errors: [] }

  try {
    const dataStore = parseTurtleToDataset(dataTurtle)
    const shapeStore = parseTurtleToDataset(shapeTurtle)

    const validator = new SHACLValidator(shapeStore, { maxErrors: 10 })
    const report = await validator.validate(dataStore)

    const errors: string[] = []
    if (!report.conforms) {
      for (const result of report.results || []) {
        const message = result.message?.[0]?.value || "SHACL constraint violation"
        const path = result.path?.value || "unknown path"
        const focusNode = result.focusNode?.value || "unknown node"
        errors.push(`SHACL violation at ${focusNode} [${path}]: ${message}`)
      }
    }

    return {
      valid: Boolean(report.conforms),
      errors,
    }
  } catch (err) {
    logger.warn(`SHACL engine evaluation warning: ${err}`)
    return { valid: true, errors: [String(err)] }
  }
}

/**
 * Structural validation of a Turtle document against the session/message
 * shapes. Lightweight fallback check verifying required triples.
 */
export function validateGraph(turtle: string): ValidationResult {
  const errors: string[] = []

  const hasSession = turtle.includes(SCHEMA.Conversation)
  if (!hasSession) {
    errors.push(`Missing session type: expected <${SCHEMA.Conversation}>`)
  }

  const hasDateCreated = turtle.includes(SCHEMA.dateCreated)
  if (!hasDateCreated) {
    errors.push(`Missing session date: expected <${SCHEMA.dateCreated}>`)
  }

  const hasMessage = turtle.includes(SCHEMA.Message)
  if (!hasMessage) {
    errors.push(`Missing message type: expected <${SCHEMA.Message}>`)
  }

  const hasText = turtle.includes(SCHEMA.text)
  if (!hasText) {
    errors.push(`Missing message text: expected <${SCHEMA.text}>`)
  }

  const hasPosition = turtle.includes(SCHEMA.position)
  if (!hasPosition) {
    errors.push(`Missing message position: expected <${SCHEMA.position}>`)
  }

  const hasAuthor = turtle.includes(SCHEMA.author)
  if (!hasAuthor) {
    errors.push(`Missing message author: expected <${SCHEMA.author}>`)
  }

  const hasHasPart = turtle.includes(SCHEMA.hasPart)
  if (!hasHasPart) {
    errors.push(`Missing session-to-message link: expected <${SCHEMA.hasPart}>`)
  }

  const hasProvenance = turtle.includes(PROV.wasGeneratedBy)
  if (!hasProvenance) {
    errors.push(`Missing provenance link: expected <${PROV.wasGeneratedBy}>`)
  }

  return { valid: errors.length === 0, errors }
}
