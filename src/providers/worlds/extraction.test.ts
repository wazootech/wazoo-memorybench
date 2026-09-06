import { describe, expect, it } from "bun:test"
import { DataFactory, Parser, Store } from "n3"
import { claimsToTurtle, type ExtractedClaim } from "./extraction"
import { validateShaclGraph } from "./shapes"
import { PROV, RDF, SCHEMA, WORLDS } from "./ontology"

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

  it("types Person-domain claims as claims, not schema:Person, and passes SHACL", async () => {
    const claims: ExtractedClaim[] = [
      {
        domainClass: "Person",
        subject: "Anna",
        action: "works as",
        object: "a nurse at Harborview Medical Center",
        claimText: "Anna works as a nurse at Harborview Medical Center.",
      },
    ]

    const turtle = claimsToTurtle(claims, "session-48")

    // The claim node must stay in the worlds:Claim hierarchy: typing it
    // schema:Person would trigger PERSON_SHAPE, which requires schema:name.
    expect(turtle).toContain(`<urn:claim:session-48/0> <${RDF.type}> <${WORLDS.FactClaim}> .`)
    expect(turtle).toContain(`<urn:claim:session-48/0> <${RDF.type}> <${WORLDS.Claim}> .`)
    expect(turtle).not.toContain(`<urn:claim:session-48/0> <${RDF.type}> <${SCHEMA.Person}> .`)

    const shacl = await validateShaclGraph(turtle)
    expect(shacl.valid).toBe(true)
    expect(shacl.errors).toHaveLength(0)
  })
})

describe("claimsToTurtle domain-class audit", () => {
  const { namedNode } = DataFactory

  function parseTurtleStore(turtle: string): Store {
    const parser = new Parser()
    const store = new Store()
    store.addQuads(parser.parse(turtle))
    return store
  }

  const DOMAIN_CASES: Array<{ name: string; emitsClaimNode: boolean; claim: ExtractedClaim }> = [
    {
      name: "Person",
      emitsClaimNode: true,
      claim: {
        domainClass: "Person",
        subject: "Anna",
        action: "works as",
        object: "a nurse at Harborview Medical Center",
        claimText: "Anna works as a nurse at Harborview Medical Center.",
      },
    },
    {
      name: "Event",
      emitsClaimNode: false,
      claim: {
        domainClass: "Event",
        subject: "Alice",
        action: "applied for",
        object: "asylum decision",
        claimText: "Alice applied for an asylum decision.",
        when: "2022-03-15",
        status: "Postponed",
      },
    },
    {
      name: "Action",
      emitsClaimNode: false,
      claim: {
        domainClass: "Action",
        subject: "Bob",
        action: "moved to",
        object: "Seattle",
        claimText: "Bob moved to Seattle.",
      },
    },
    {
      name: "MedicalCondition",
      emitsClaimNode: false,
      claim: {
        domainClass: "MedicalCondition",
        subject: "Bob",
        action: "diagnosed with",
        object: "Asthma",
        claimText: "Bob was diagnosed with asthma in 2021.",
      },
    },
    {
      name: "Organization",
      emitsClaimNode: false,
      claim: {
        domainClass: "Organization",
        subject: "Charlie",
        action: "works for",
        object: "Wazoo Technologies",
        claimText: "Charlie works for Wazoo Technologies as an engineer.",
      },
    },
    {
      name: "Preference",
      emitsClaimNode: true,
      claim: {
        domainClass: "Preference",
        subject: "Diana",
        action: "prefers",
        object: "tea over coffee",
        claimText: "Diana prefers tea over coffee.",
      },
    },
    {
      name: "Relationship",
      emitsClaimNode: true,
      claim: {
        domainClass: "Relationship",
        subject: "Diana",
        action: "is married to",
        object: "Eve",
        claimText: "Diana is married to Eve.",
      },
    },
    {
      name: "Fact",
      emitsClaimNode: true,
      claim: {
        domainClass: "Fact",
        subject: "Frank",
        action: "was born in",
        object: "Oslo",
        claimText: "Frank was born in Oslo.",
      },
    },
    {
      // The `type` field takes precedence in the claim-branch lookup. A
      // capitalized schema class there must still resolve to a claim type,
      // never a schema entity type (the shape-violation class #50 fixed for
      // Person).
      name: "Fact with type:Event",
      emitsClaimNode: true,
      claim: {
        domainClass: "Fact",
        type: "Event",
        subject: "Grace",
        action: "held",
        object: "a workshop",
        claimText: "Grace held a workshop.",
      },
    },
  ]

  for (const { name, emitsClaimNode, claim } of DOMAIN_CASES) {
    it(`passes SHACL and never types a claim node as a schema entity (${name})`, async () => {
      const turtle = claimsToTurtle([claim], "audit-session")

      const shacl = await validateShaclGraph(turtle)
      expect(shacl.valid).toBe(true)
      expect(shacl.errors).toHaveLength(0)

      const store = parseTurtleStore(turtle)

      // Type-vs-entity invariant: no claim node may carry a schema.org class
      // type (that is the mismatch PERSON_SHAPE caught for "Person").
      const schemaTyped = store
        .getQuads(null, namedNode(RDF.type), null, null)
        .filter((q) => q.object.value.startsWith("http://schema.org/"))
      for (const q of schemaTyped) {
        expect(q.subject.value).not.toMatch(/^urn:claim:/)
      }

      // Claim-branch classes emit worlds:Claim nodes; entity-branch classes
      // (Event/Action/MedicalCondition/Organization) emit schema entity nodes
      // instead, so no claim node is expected there.
      if (emitsClaimNode) {
        const claimNodes = store
          .getQuads(null, namedNode(RDF.type), namedNode(WORLDS.Claim), null)
          .map((q) => q.subject.value)
        expect(claimNodes.length).toBeGreaterThan(0)
      }

      // The person entity node is present and named (PERSON_SHAPE).
      const personTypeQuads = store.getQuads(
        null,
        namedNode(RDF.type),
        namedNode(SCHEMA.Person),
        null
      )
      expect(personTypeQuads).toHaveLength(1)
      const personUri = personTypeQuads[0]!.subject
      expect(store.getQuads(personUri, namedNode(SCHEMA.name), null, null)).toHaveLength(1)
    })
  }
})
