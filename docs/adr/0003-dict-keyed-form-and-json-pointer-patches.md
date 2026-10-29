# 0003. Dict-keyed form, JSON Pointer patches with provenance

- Status: Accepted
- Date: 2026-10-29

## Context and problem statement

The draft form is written concurrently by AI roles (every few seconds) and by people (crew
before review, supervisor during review). Clients render it live. We must know, for every
field, who wrote it, from what evidence, with which model and prompt version, and we must
diff the AI draft against the signed form.

## Decision drivers

- Concurrent writers without lost updates
- Stable addresses for fields so patches, evidence and gaps can refer to them
- Field-level provenance for audit and edit-rate metrics
- Small live updates over WebSockets

## Considered options

1. Replace the whole form document on each update
2. RFC 6902 JSON Patch against lists (hazards as arrays)
3. JSON Patch with JSON Pointer paths against a form whose collections are dicts keyed by stable ids

## Decision outcome

Chosen option 3. Collections in the form (hazards, controls, tasks) are objects keyed by stable
ids, so a path such as `/hazards/hz-live-lv/controls/ct-isolate` keeps meaning the same thing
when other entries are added or removed. Every patch carries provenance: source (`ai`/`human`),
role, evidence segment ids, confidence, model and prompt version. The form API applies patches
in a transaction, validates the result against the schema and rules, stores a revision, and
publishes `form.patched`. Human patches force `provenance.source = "human"` server-side.

### Consequences

- Good: array-index races disappear; replays of the same patch are idempotent.
- Good: the AI-vs-final diff is a straightforward comparison of keyed paths.
- Bad: ids must be generated deterministically by roles (from library codes) to avoid duplicates.
- Bad: clients need ordering when rendering keyed collections.
