# 0006. Real-time fan-out via Web PubSub with a negotiate endpoint

- Status: Accepted
- Date: 2026-10-29

## Context and problem statement

Form patches, gaps, transcript lines and voice prompts must reach every viewer of a session
(crew device, supervisor portal) within a second. Events are produced by the form API and the
orchestrator, which may run on many replicas, while clients are connected to whichever gateway
replica they reached.

## Decision drivers

- Producers and connections on different replicas
- Thousands of concurrent read-only subscribers at the morning peak
- Clients must not hold long-lived credentials
- Same client code locally and in Azure

## Considered options

1. Gateway fan-out with a shared backplane (Redis pub/sub)
2. Azure Web PubSub groups, clients connect directly with short-lived tokens
3. Azure SignalR Service

## Decision outcome

Chosen option 2. Producers publish an `EventEnvelope` to group `session.<id>`. Clients call
`GET /api/sessions/{id}/negotiate` on the gateway, which checks the caller may view the session
and returns a URL: locally `ws://…/ws/live/{id}` served by the gateway itself; in Azure a Web
PubSub client URL with a short-lived token scoped to that group. Clients are read-only. Publishing
is best-effort; clients resync with `GET /api/sessions/{id}` after reconnecting.

### Consequences

- Good: no backplane to run; producers and subscribers scale independently.
- Good: authorisation stays in our code (negotiate); Web PubSub has local auth disabled and is
  reached by services over a private endpoint.
- Bad: Web PubSub keeps a public endpoint for client connections (REST and server connections
  are blocked publicly by network ACLs).
- Bad: lost events are possible; clients must handle resync.
