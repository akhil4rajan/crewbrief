# 0001. The orchestrator is a deterministic state machine, not an LLM

- Status: Accepted
- Date: 2026-10-29

## Context and problem statement

A briefing involves several specialist steps: extract observations, ground hazards in the
library, write form patches, verify, ask the crew about gaps. Something has to decide when each
step runs and when the session moves on. Agent frameworks let an LLM plan this. Ours is a
safety process: a supervisor and an auditor must be able to explain why something happened,
and the live loop has a latency budget of about two seconds from speech to field.

## Decision drivers

- Auditability: every scheduling decision must be explainable after the fact
- Latency and cost: no LLM call that does not need language understanding
- Predictability under load (1,000+ concurrent sessions)
- Testability without a model in the loop

## Considered options

1. LLM planner/agent decides which role runs next
2. Deterministic state machine schedules narrow LLM roles
3. Single large prompt that does everything per window

## Decision outcome

Chosen option 2. `services/orchestrator` holds a per-session runner driven by the session
state (`CREATED → BRIEFING → DRAFTING ⇄ GAP_CHECK → REVIEW → SIGNED → SUBMITTED`), a fixed
extraction interval, verifier milestones and a voice-prompt cooldown. LLMs only do the narrow
jobs that need language understanding (ADR 0004 covers what stays out of prompts).

### Consequences

- Good: every transition and role invocation is logged and audited with its inputs' versions.
- Good: the real-time path costs a known number of LLM calls per session per minute.
- Good: the whole loop runs offline with heuristic roles (ADR 0002), so it is testable in CI.
- Bad: new behaviours need code changes, not prompt changes.
- Bad: per-session runners live in memory, so horizontal scale needs session-affine routing
  (see `docs/runbooks/scaling-morning-peak.md`). Recovery after restart reloads active sessions
  from the form API.
