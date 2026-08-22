import { describe, expect, it } from "bun:test";
import { DataFactory, Parser, Store } from "n3";
import { claimsToTurtle, type ExtractedClaim } from "./extraction";
import { PROV, RDF, SCHEMA } from "./ontology";

const { namedNode } = DataFactory;

function parseTurtleStore(turtle: string): Store {
  const parser = new Parser();
  const store = new Store();
  const quads = parser.parse(turtle);
  store.addQuads(quads);
  return store;
}

describe("Multi-Hop Domain Graph Reasoning", () => {
  it("queries multi-hop Person to Organization employment (schema:worksFor)", () => {
    const claims: ExtractedClaim[] = [
      {
        domainClass: "Organization",
        subject: "Alice Smith",
        action: "works for",
        object: "Acme Corp",
        claimText: "Alice Smith works for Acme Corp as a software architect.",
      },
    ];

    const turtle = claimsToTurtle(claims, "session-test-01");
    const store = parseTurtleStore(turtle);

    // Direct N3 graph pattern check
    const personQuads = store.getQuads(
      null,
      namedNode(RDF.type),
      namedNode(SCHEMA.Person),
      null,
    );
    expect(personQuads).toHaveLength(1);

    const personUri = personQuads[0]!.subject;
    const worksForQuads = store.getQuads(
      personUri,
      namedNode(SCHEMA.worksFor),
      null,
      null,
    );
    expect(worksForQuads).toHaveLength(1);

    const orgUri = worksForQuads[0]!.object;
    const orgNameQuads = store.getQuads(
      orgUri,
      namedNode(SCHEMA.name),
      null,
      null,
    );
    expect(orgNameQuads).toHaveLength(1);
    expect(orgNameQuads[0]!.object.value).toBe("Acme Corp");
  });

  it("queries multi-hop Event about Person with status and provenance (schema:about, schema:eventStatus)", () => {
    const claims: ExtractedClaim[] = [
      {
        domainClass: "Event",
        subject: "Bob Jones",
        action: "applied for",
        object: "visa extension",
        claimText: "Bob Jones applied for a visa extension in London.",
        when: "2023-06-10",
        where: "London",
        status: "Postponed",
      },
    ];

    const turtle = claimsToTurtle(claims, "session-test-02");
    const store = parseTurtleStore(turtle);

    const eventQuads = store.getQuads(
      null,
      namedNode(RDF.type),
      namedNode(SCHEMA.Event),
      null,
    );
    expect(eventQuads).toHaveLength(1);

    const eventUri = eventQuads[0]!.subject;
    const aboutQuads = store.getQuads(
      eventUri,
      namedNode(SCHEMA.about),
      null,
      null,
    );
    expect(aboutQuads).toHaveLength(1);

    const personUri = aboutQuads[0]!.object;
    const personNameQuads = store.getQuads(
      personUri,
      namedNode(SCHEMA.name),
      null,
      null,
    );
    expect(personNameQuads[0]!.object.value).toBe("Bob Jones");

    const statusQuads = store.getQuads(
      eventUri,
      namedNode(SCHEMA.eventStatus),
      null,
      null,
    );
    expect(statusQuads[0]!.object.value).toBe(SCHEMA.EventPostponed);

    const locationQuads = store.getQuads(
      eventUri,
      namedNode(SCHEMA.location),
      null,
      null,
    );
    expect(locationQuads[0]!.object.value).toBe("London");
  });

  it("queries multi-hop Action with agent entity (schema:agent)", () => {
    const claims: ExtractedClaim[] = [
      {
        domainClass: "Action",
        subject: "Charlie Brown",
        action: "relocated to",
        object: "San Francisco",
        claimText: "Charlie Brown relocated to San Francisco for a new role.",
      },
    ];

    const turtle = claimsToTurtle(claims, "session-test-03");
    const store = parseTurtleStore(turtle);

    const actionQuads = store.getQuads(
      null,
      namedNode(RDF.type),
      namedNode(SCHEMA.Action),
      null,
    );
    expect(actionQuads).toHaveLength(1);

    const actionUri = actionQuads[0]!.subject;
    const agentQuads = store.getQuads(
      actionUri,
      namedNode(SCHEMA.agent),
      null,
      null,
    );
    expect(agentQuads).toHaveLength(1);

    const personUri = agentQuads[0]!.object;
    const personNameQuads = store.getQuads(
      personUri,
      namedNode(SCHEMA.name),
      null,
      null,
    );
    expect(personNameQuads[0]!.object.value).toBe("Charlie Brown");

    const objectQuads = store.getQuads(
      actionUri,
      namedNode(SCHEMA.object),
      null,
      null,
    );
    expect(objectQuads[0]!.object.value).toBe("San Francisco");
  });

  it("queries multi-hop MedicalCondition about Person (schema:MedicalCondition)", () => {
    const claims: ExtractedClaim[] = [
      {
        domainClass: "MedicalCondition",
        subject: "Diana Prince",
        action: "diagnosed with",
        object: "Migraine",
        claimText: "Diana Prince was diagnosed with migraine headaches.",
      },
    ];

    const turtle = claimsToTurtle(claims, "session-test-04");
    const store = parseTurtleStore(turtle);

    const medQuads = store.getQuads(
      null,
      namedNode(RDF.type),
      namedNode(SCHEMA.MedicalCondition),
      null,
    );
    expect(medQuads).toHaveLength(1);

    const medUri = medQuads[0]!.subject;
    const aboutQuads = store.getQuads(
      medUri,
      namedNode(SCHEMA.about),
      null,
      null,
    );
    expect(aboutQuads).toHaveLength(1);

    const personUri = aboutQuads[0]!.object;
    const personNameQuads = store.getQuads(
      personUri,
      namedNode(SCHEMA.name),
      null,
      null,
    );
    expect(personNameQuads[0]!.object.value).toBe("Diana Prince");

    const nameQuads = store.getQuads(
      medUri,
      namedNode(SCHEMA.name),
      null,
      null,
    );
    expect(nameQuads[0]!.object.value).toBe("Migraine");
  });
});
