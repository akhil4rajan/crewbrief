# 0007. SQLite locally, Cosmos DB in Azure, behind one repository interface

- Status: Accepted
- Date: 2026-10-29

## Context and problem statement

The form API stores sessions, drafts and revisions, transcript segments, gaps, audit entries
and tombstones. Access is almost always "everything for one session". Locally we want zero
setup; in Azure we want elastic scale, point-in-time restore, private networking, Entra-only
auth and optional customer-managed keys.

## Decision drivers

- Per-session access pattern on the hot path
- Offline local mode (ADR 0002)
- Data residency and encryption requirements in Azure

## Considered options

1. PostgreSQL everywhere (Flexible Server in Azure)
2. Cosmos DB everywhere (emulator locally)
3. A repository interface with SQLite (local) and Cosmos DB NoSQL (Azure) implementations

## Decision outcome

Chosen option 3. `services/form_api/store` defines the repository; both implementations store
the same JSON documents, one table/container per collection, partitioned by `session_id` in
Cosmos DB. Containers are created by Bicep (`infra/bicep/modules/cosmos.bicep`): with
data-plane RBAC only, the app cannot create them. Serverless is the default capacity mode;
provisioned autoscale and CMK are parameters.

### Consequences

- Good: single-partition reads and writes for every hot-path operation.
- Good: no emulator needed locally; SQLite file lives in `./var`.
- Bad: cross-session queries (dashboards, edit-rate metrics) are cross-partition in Cosmos
  DB; keep them off the hot path and paginated.
- Bad: the container list exists in two places (store code and Bicep) and must stay in sync.
