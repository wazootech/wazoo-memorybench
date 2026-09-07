import { describe, expect, it } from "bun:test"
import { DataFactory, Parser, Store } from "n3"
import {
  claimsToTurtle,
  convergeAlias,
  dedupeClaims,
  shortHash,
  type ExtractedClaim,
} from "./extraction"
import { validateShaclGraph } from "./shapes"
import { PROV, RDF, SCHEMA, WORLDS } from "./ontology"

const { namedNode, literal } = DataFactory

function parseTurtleStore(turtle: string): Store {
  const parser = new Parser()
  const store = new Store()
  store.addQuads(parser.parse(turtle))
  return store
}

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
    expect(turtle).toContain(`<urn:event:session-42/${shortHash("Alice applied for an asylum decision.")}> <${RDF.type}> <${SCHEMA.Event}> .`)
    expect(turtle).toContain(
      `<urn:event:session-42/${shortHash("Alice applied for an asylum decision.")}> <${SCHEMA.about}> <urn:person:session-42/alice> .`
    )
    expect(turtle).toContain(
      `<urn:event:session-42/${shortHash("Alice applied for an asylum decision.")}> <${SCHEMA.text}> "Alice applied for an asylum decision." .`
    )
    expect(turtle).toContain(
      `<urn:event:session-42/${shortHash("Alice applied for an asylum decision.")}> <${SCHEMA.eventStatus}> <${SCHEMA.EventPostponed}> .`
    )
    expect(turtle).toContain(
      `<urn:event:session-42/${shortHash("Alice applied for an asylum decision.")}> <${PROV.wasDerivedFrom}> <urn:session:session-42> .`
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
      `<urn:medical:session-99/${shortHash("Asthma")}> <${RDF.type}> <${SCHEMA.MedicalCondition}> .`
    )
    expect(turtle).toContain(`<urn:action:session-99/${shortHash("moved to|Seattle")}> <${RDF.type}> <${SCHEMA.Action}> .`)
    expect(turtle).toContain(
      `<urn:action:session-99/${shortHash("moved to|Seattle")}> <${SCHEMA.agent}> <urn:person:session-99/bob> .`
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
      `<urn:claim:session-100/${shortHash(
        "Charlie works for Wazoo Technologies as an engineer."
      )}> <${PROV.wasDerivedFrom}> <urn:session:session-100> .`
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
    expect(turtle).toContain(`<urn:claim:session-48/${shortHash("Anna works as a nurse at Harborview Medical Center.")}> <${RDF.type}> <${WORLDS.FactClaim}> .`)
    expect(turtle).toContain(`<urn:claim:session-48/${shortHash("Anna works as a nurse at Harborview Medical Center.")}> <${RDF.type}> <${WORLDS.Claim}> .`)
    expect(turtle).not.toContain(`<urn:claim:session-48/${shortHash("Anna works as a nurse at Harborview Medical Center.")}> <${RDF.type}> <${SCHEMA.Person}> .`)

    const shacl = await validateShaclGraph(turtle)
    expect(shacl.valid).toBe(true)
    expect(shacl.errors).toHaveLength(0)
  })

  it("does not mint a urn:person:/schema:Person node when the subject is the venue or organization itself", async () => {
    const claims: ExtractedClaim[] = [
      {
        domainClass: "Event",
        subject: "Harborview charity gala",
        claimText: "Melanie and Anna met at the Harborview charity gala in June.",
        when: "2026-06",
        where: "Harborview charity gala",
      },
      {
        domainClass: "Organization",
        subject: "Harborview Medical Center",
        claimText: "Harborview Medical Center is the employer of Melanie.",
      },
    ]

    const turtle = claimsToTurtle(claims, "session-self")

    // No person URNs may exist for the venue or the organization...
    expect(turtle).not.toContain("<urn:person:session-self/harborview-charity-gala>")
    expect(turtle).not.toContain("<urn:person:session-self/harborview-medical-center>")
    expect(turtle).not.toContain(`<${SCHEMA.Person}>`)

    // ...and the org node must carry the org's real name, never the class
    // name leaked in as a literal schema:name.
    expect(turtle).toContain(
      `<urn:org:session-self/harborview-medical-center> <${SCHEMA.name}> "Harborview Medical Center" .`
    )
    expect(turtle).not.toContain(`<${SCHEMA.name}> "Organization" .`)

    // The org's own employment assertion gets a uniform claim node with a
    // content-keyed URN.
    const orgClaimHash = shortHash(
      "Harborview Medical Center is the employer of Melanie."
    )
    expect(turtle).toContain(
      `<urn:claim:session-self/${orgClaimHash}> <${RDF.type}> <${WORLDS.Claim}> .`
    )
    expect(turtle).toContain(
      `<urn:claim:session-self/${orgClaimHash}> <${PROV.wasDerivedFrom}> <urn:session:session-self> .`
    )

    const shacl = await validateShaclGraph(turtle)
    expect(shacl.valid).toBe(true)
    expect(shacl.errors).toHaveLength(0)
  })

  it("gives an org-subject employment claim a uniform claim node instead of literals on the org", async () => {
    const claims: ExtractedClaim[] = [
      {
        domainClass: "Organization",
        subject: "Globex Corporation",
        claimText: "Globex Corporation is the employer of Frank.",
      },
    ]

    const turtle = claimsToTurtle(claims, "session-org-subject")
    const store = parseTurtleStore(turtle)

    // Typed org node with the real name...
    const orgQuads = store.getQuads(
      null,
      namedNode(RDF.type),
      namedNode(SCHEMA.Organization),
      null
    )
    expect(orgQuads).toHaveLength(1)
    const orgUri = orgQuads[0]!.subject
    expect(orgUri.value).toBe("urn:org:session-org-subject/globex-corporation")
    const nameQuads = store.getQuads(orgUri, namedNode(SCHEMA.name), null, null)
    expect(nameQuads[0]!.object.value).toBe("Globex Corporation")

    // ...plus a uniform claim node: same urn:claim: scheme, typed
    // worlds:Claim, provenance-anchored, about the org itself, with the SPO
    // decomposition other claims get. No person node, no claimText literals
    // dangling off the entity.
    const claimQuads = store.getQuads(
      null,
      namedNode(WORLDS.claimText),
      literal("Globex Corporation is the employer of Frank."),
      null
    )
    expect(claimQuads).toHaveLength(1)
    const claimUri = claimQuads[0]!.subject
    expect(claimUri.value).toBe(
      `urn:claim:session-org-subject/${shortHash(
        "Globex Corporation is the employer of Frank."
      )}`
    )
    const typeQuads = store.getQuads(claimUri, namedNode(RDF.type), null, null)
    expect(typeQuads).toHaveLength(1)
    expect(typeQuads[0]!.object.value).toBe(WORLDS.Claim)
    const aboutQuads = store.getQuads(claimUri, namedNode(SCHEMA.about), null, null)
    expect(aboutQuads).toHaveLength(1)
    expect(aboutQuads[0]!.object.value).toBe(orgUri.value)
    expect(
      store.getQuads(claimUri, namedNode(PROV.wasDerivedFrom), null, null)
    ).toHaveLength(1)
    expect(
      store.getQuads(orgUri, namedNode(WORLDS.claimText), null, null)
    ).toHaveLength(0)

    const shacl = await validateShaclGraph(turtle)
    expect(shacl.valid).toBe(true)
    expect(shacl.errors).toHaveLength(0)
  })
})

describe("dedupeClaims", () => {
  it("drops duplicate claimText regardless of casing, surrounding whitespace, or type", () => {
    const claims: ExtractedClaim[] = [
      { domainClass: "Person", subject: "Anna", claimText: "Anna enjoys hiking on weekends." },
      { domainClass: "Preference", subject: "Anna", claimText: "Anna enjoys hiking on weekends." },
      { type: "Fact", subject: "Anna", claimText: "  anna enjoys HIKING on weekends!  " },
      { domainClass: "Fact", subject: "Anna", claimText: "Anna climbed Mount Rainier." },
    ]

    const deduped = dedupeClaims(claims)

    expect(deduped).toHaveLength(2)
    expect(deduped[0]!.claimText).toBe("Anna enjoys hiking on weekends.")
    expect(deduped[1]!.claimText).toBe("Anna climbed Mount Rainier.")
  })

  it("keeps claims that differ in content even if they share the subject", () => {
    const claims: ExtractedClaim[] = [
      { domainClass: "Fact", subject: "Melanie", claimText: "Melanie moved to Seattle." },
      {
        domainClass: "Fact",
        subject: "Melanie",
        claimText: "Melanie moved to Seattle last month!",
      },
    ]

    expect(dedupeClaims(claims)).toHaveLength(2)
  })

  it("does not mutate the input array", () => {
    const claims: ExtractedClaim[] = [
      { domainClass: "Fact", subject: "A", claimText: "Same text." },
      { domainClass: "Fact", subject: "B", claimText: "Same text." },
    ]
    const snapshot = [...claims]

    dedupeClaims(claims)

    expect(claims).toEqual(snapshot)
  })
})

describe("claimsToTurtle emitted-line dedupe", () => {
  it("emits shared entity statements once even across many claims", () => {
    const claims: ExtractedClaim[] = [
      { domainClass: "Fact", subject: "Melanie", claimText: "Melanie moved to Seattle." },
      { domainClass: "Fact", subject: "Melanie", claimText: "Melanie likes tea." },
      { domainClass: "Fact", subject: "Melanie", claimText: "Melanie runs on weekends." },
    ]

    const turtle = claimsToTurtle(claims, "session-dedupe")
    const statementLines = turtle
      .split("\n")
      .filter((l) => l.startsWith("<"))

    const uniqueStatements = new Set(statementLines)
    expect(statementLines.length).toBe(uniqueStatements.size)
    // The person node still exists, named, after collapsing repeats.
    expect(turtle.match(/schema\.org\/name> "Melanie" \./g)).toHaveLength(1)
  })
})

describe("claimsToTurtle IRI stability", () => {
  it("gives the same claimText the same claim URN regardless of order", () => {
    const claim: ExtractedClaim = {
      domainClass: "Fact",
      subject: "Anna",
      claimText: "Anna enjoys hiking on weekends.",
    }
    const a = claimsToTurtle(
      [claim, { domainClass: "Fact", subject: "Anna", claimText: "Anna likes tea." }],
      "s"
    )
    const b = claimsToTurtle(
      [{ domainClass: "Fact", subject: "Anna", claimText: "Anna likes tea." }, claim],
      "s"
    )
    const hash = shortHash("Anna enjoys hiking on weekends.")
    expect(a).toContain(`<urn:claim:s/${hash}>`)
    expect(b).toContain(`<urn:claim:s/${hash}>`)
  })

  it("reuses the identical event URN when the same event claim reappears", () => {
    const claim: ExtractedClaim = {
      domainClass: "Event",
      subject: "Alice",
      claimText: "Alice applied for an asylum decision.",
      when: "2022-03-15",
    }
    const turtle = claimsToTurtle([claim, claim], "s")
    // Content-keyed: both copies hash to one URN, and the line dedupe
    // collapses them into a single rdf:type statement.
    const hash = shortHash(claim.claimText)
    expect(
      turtle.match(new RegExp(`urn:event:s/${hash}> <[^>]+22-rdf-syntax-ns#type>`, "g"))
    ).toHaveLength(1)
  })

  it("converges 'Acme Corp' and 'Acme Corporation' onto one org node", () => {
    const turtle = claimsToTurtle(
      [
        {
          domainClass: "Organization",
          subject: "Frank",
          object: "Acme Corp",
          claimText: "Frank works for Acme Corp.",
        },
        {
          domainClass: "Organization",
          subject: "Frank",
          object: "Acme Corporation",
          claimText: "Frank has been employed at Acme Corporation for years.",
        },
      ],
      "s"
    )
    // First variant seen wins; both aliases converge on one org node that
    // carries both name literals (multi-name is allowed by ORGANIZATION_SHAPE).
    expect(turtle).toContain('<urn:org:s/acme-corp> <http://schema.org/name> "Acme Corp" .')
    expect(turtle).toContain(
      '<urn:org:s/acme-corp> <http://schema.org/name> "Acme Corporation" .'
    )
    expect(turtle).not.toContain("urn:org:s/acme-corporation")
  })
})

describe("convergeAlias", () => {
  it("collapses plurals and legal suffixes to the first canonical form", () => {
    const registry = new Map<string, string>()
    expect(convergeAlias("acme-corp", registry)).toBe("acme-corp")
    expect(convergeAlias("acme", registry)).toBe("acme-corp")
    expect(convergeAlias("acme-corporation", registry)).toBe("acme-corp")
    expect(convergeAlias("acme-inc", registry)).toBe("acme-corp")
  })

  it("keeps risky prefix aliases distinct", () => {
    const registry = new Map<string, string>()
    expect(convergeAlias("mel", registry)).toBe("mel")
    expect(convergeAlias("melanie", registry)).toBe("melanie")
    expect(registry.get("mel")).toBe("mel")
  })
})

describe("claimsToTurtle domain-class audit", () => {
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
