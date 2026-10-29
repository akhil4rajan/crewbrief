# 0004. Safety rules live in code, not prompts

- Status: Accepted
- Date: 2026-10-29

## Context and problem statement

Some requirements are non-negotiable: a high-risk hazard needs at least one isolation or
engineering control; a hazard is never marked "not present" because nobody mentioned it; only
a supervisor can sign off. Prompted models follow such instructions most of the time, which is
not good enough for safety rules.

## Decision drivers

- Rules must hold 100% of the time and be unit-testable
- Rules must be reviewable by safety SMEs without reading prompts
- Rule changes must be versioned and audited like code

## Considered options

1. State the rules in role prompts
2. Enforce them in deterministic code (`packages/rules`) and let the LLM verifier add judgement on top

## Decision outcome

Chosen option 2. `packages/rules` owns form schema validation, hazard/control code mapping, the
critical-hazard control rule, the "never infer absence" rule and sign-off permissions. The form
API and orchestrator call it on every write and at sign-off. The LLM verifier looks for things
code cannot (unsupported evidence, contradictions) and its findings are merged with rule
findings into one gap list.

### Consequences

- Good: rules cannot be prompt-injected or forgotten by a model upgrade.
- Good: changes to rules go through CODEOWNERS review and the eval gate.
- Bad: rules expressed in code need an engineer to change them; SMEs review, they do not edit.
