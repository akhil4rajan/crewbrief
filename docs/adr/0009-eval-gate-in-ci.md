# 0009. Eval gate in CI

- Status: Accepted
- Date: 2026-10-29

## Context and problem statement

A form that looks complete but is wrong is worse than no form. Prompts, schemas, rules and
model deployments change behaviour in ways unit tests do not catch. We need every such change
measured against the same yardstick before it merges.

## Decision drivers

- Recall of critical hazards matters more than precision
- Every filled field must cite evidence (hallucination control)
- Regressions must block merges automatically, not rely on reviewers noticing

## Considered options

1. Manual eval before releases
2. Eval on every pull request with thresholds that fail the build

## Decision outcome

Chosen option 2. The `eval` job in `.github/workflows/ci.yml` runs
`python eval/run_eval.py --dataset eval/datasets/sample_v1 --report eval/reports/ --fail-under`
in local mode. Thresholds live in `eval/thresholds.yaml` (critical hazard recall, evidence
coverage and others). The report is uploaded as an artifact and written to the job summary.
Pull requests that touch prompts, schemas, rules or model deployments must also attach a report
(see the PR template). The full gold set (`eval/datasets/gold_*`, not committed) is run with
real models before changing deployments.

### Consequences

- Good: regressions in the pipeline are caught on every PR.
- Good: the thresholds are versioned and reviewed like code.
- Bad: CI runs the heuristic roles, so it gates pipeline and rules changes; model and prompt
  quality still needs the gold-set run against Azure.
