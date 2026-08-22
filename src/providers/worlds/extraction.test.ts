import { describe, expect, it } from "bun:test"
import { claimsToTurtle, type ExtractedClaim } from "./extraction"
import { validateShaclGraph } from "./shapes"
import { PROV, RDF, SCHEMA } from "./ontology"

describe("claimsToTurtle", () => {
  it("converts domain Event claims into direct schema:Event quads with provenance and text", async () => {
    const claims: ExtractedClaim[] = [
      {
        domainClass: "Event",
        subject: "Alice",
        action: "applied for",
        object: "asylum decision",
        claimText: "Alice applied for an asylum decision.",
        when: "2022-03-15",
        status: "Postponed",
      },
    ]

    const turtle = claimsToTurtle(claims, "session-42")

    expect(turtle).toContain(`<urn:person:session-42/alice> <${RDF.type}> <${SCHEMA.Person}> .`)
    expect(turtle).toContain(`<urn:person:session-42/alice> <${SCHEMA.name}> "Alice" .`)
    expect(turtle).toContain(`<urn:event:session-42/0> <${RDF.type}> <${SCHEMA.Event}> .`)
    expect(turtle).toContain(
      `<urn:event:session-42/0> <${SCHEMA.about}> <urn:person:session-42/alice> .`
    )
    expect(turtle).toContain(
      `<urn:event:session-42/0> <${SCHEMA.text}> "Alice applied for an asylum decision." .`
    )
    expect(turtle).toContain(
      `<urn:event:session-42/0> <${SCHEMA.eventStatus}> <${SCHEMA.EventPostponed}> .`
    )
    expect(turtle).toContain(
      `<urn:event:session-42/0> <${PROV.wasDerivedFrom}> <urn:session:session-42> .`
    )

    const shacl = await validateShaclGraph(turtle)
    expect(shacl.valid).toBe(true)
    expect(shacl.errors).toHaveLength(0)
  })

  it("converts MedicalCondition and Action assertions into direct domain quads", async () => {
    const claims: ExtractedClaim[] = [
      {
        domainClass: "MedicalCondition",
        subject: "Bob",
        action: "diagnosed with",
        object: "Asthma",
        claimText: "Bob was diagnosed with asthma in 2021.",
      },
      {
        domainClass: "Action",
        subject: "Bob",
        action: "moved to",
        object: "Seattle",
        claimText: "Bob moved to Seattle.",
      },
    ]

    const turtle = claimsToTurtle(claims, "session-99")

    expect(turtle).toContain(
      `<urn:medical:session-99/0> <${RDF.type}> <${SCHEMA.MedicalCondition}> .`
    )
    expect(turtle).toContain(`<urn:action:session-99/1> <${RDF.type}> <${SCHEMA.Action}> .`)
    expect(turtle).toContain(
      `<urn:action:session-99/1> <${SCHEMA.agent}> <urn:person:session-99/bob> .`
    )

    const shacl = await validateShaclGraph(turtle)
    expect(shacl.valid).toBe(true)
    expect(shacl.errors).toHaveLength(0)
  })

  it("converts Organization and employment claims into direct schema:worksFor quads", async () => {
    const claims: ExtractedClaim[] = [
      {
        domainClass: "Organization",
        subject: "Charlie",
        action: "works for",
        object: "Wazoo Technologies",
        claimText: "Charlie works for Wazoo Technologies as an engineer.",
      },
    ]

    const turtle = claimsToTurtle(claims, "session-100")

    expect(turtle).toContain(
      `<urn:org:session-100/wazoo-technologies> <${RDF.type}> <${SCHEMA.Organization}> .`
    )
    expect(turtle).toContain(
      `<urn:person:session-100/charlie> <${SCHEMA.worksFor}> <urn:org:session-100/wazoo-technologies> .`
    )
    expect(turtle).toContain(
      `<urn:person:session-100/charlie> <${PROV.wasDerivedFrom}> <urn:session:session-100> .`
    )

    const shacl = await validateShaclGraph(turtle)
    expect(shacl.valid).toBe(true)
    expect(shacl.errors).toHaveLength(0)
  })
})
