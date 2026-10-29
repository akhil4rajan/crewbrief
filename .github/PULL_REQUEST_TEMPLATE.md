## What and why

<!-- What does this change, and why is it needed? Link the issue if there is one. -->

## How it was verified

<!-- Commands run, screens checked, sample briefings replayed (e.g. `make replay`). -->

## Checklist

- [ ] Branch is named `<type>/<short-description>` and contains one concern
- [ ] `make lint` and `make typecheck` pass
- [ ] **Eval report attached** (required if this touches prompts, schemas, rules or model deployments): output of `python eval/run_eval.py --dataset eval/datasets/sample_v1 --report eval/reports/`, with critical hazard recall and evidence coverage called out
- [ ] ADR added or updated in `docs/adr/` for a significant design decision
- [ ] No secrets: committed env files hold dummy values only; real keys stay in `.env.local`
- [ ] Privacy reviewed: no raw audio retained, no new personal data logged, PII redaction still applies
- [ ] Infra changes compile (`make bicep`) and the deploy runbook is still accurate
- [ ] Docs and runbooks updated where behaviour changed

## Eval summary

<!-- Paste the summary table from the eval report, or write "not applicable" and why. -->
