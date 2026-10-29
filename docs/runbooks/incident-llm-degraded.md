# Runbook: LLM degraded (latency, errors, throttling)

**Symptoms**: role latency p95 above the extraction interval; role results and audit entries
with model `heuristic-v1` (the fallback provenance) while `LLM_PROVIDER` is azure; warnings in the roles logs; Azure OpenAI 429/5xx; the live form updates slowly or with lower-quality entries;
the eval of production edit rates drifts upward.

## How the system degrades

Each LLM role has a deterministic heuristic implementation. With
`LLM_FALLBACK_TO_HEURISTIC=true` (default), a timeout (`LLM_TIMEOUT_SECONDS`, default 20) or an
error makes the role return the heuristic result instead, recorded in the audit trail with the
role's provenance, so supervisors and the edit-rate metrics can tell the difference. Safety
rules (`packages/rules`) and the verifier's rule-based gaps are unaffected: critical hazards
without controls are still raised.

## Triage

1. Latency and failures of role calls (orchestrator → roles) and warnings from the roles app:
   ```kusto
   requests
   | where timestamp > ago(1h) and cloud_RoleName == "crewbrief-roles"
   | summarize count(), failures=countif(success == false), p95=percentile(duration, 95) by name, bin(timestamp, 5m)
   ```
   ```kusto
   traces
   | where timestamp > ago(1h) and cloud_RoleName == "crewbrief-roles" and severityLevel >= 2
   | summarize count() by message, bin(timestamp, 5m)
   ```
2. Azure OpenAI metrics on the AI Services account: *Azure OpenAI Requests* by status,
   *Time to Response*, *Provisioned-managed utilization* (PTU).
3. Service Health for Azure OpenAI in Australia East.
4. Recent changes: model version, deployment SKU/capacity, prompt version (`PROMPT_VERSION`).

## Mitigate

| Cause | Action |
|---|---|
| 429 on Standard | Raise deployment capacity (`extractorCapacity`/`verifierCapacity`) if quota allows, or move to PTU (`MODEL_DEPLOYMENT_SKU=ProvisionedManaged`) |
| PTU utilisation at 100% | Add PTUs; temporarily raise `EXTRACTION_INTERVAL_SECONDS` (e.g. 8 → 12) and `VERIFIER_EVERY_N_EXTRACTIONS` to cut calls |
| Regional incident | Stay on heuristics (automatic). Do not repoint to a non-Australian region |
| Bad prompt/model release | Roll back the roles revision or `PROMPT_VERSION`; re-run the eval |
| Timeouts but healthy service | Check roles replica CPU and the scale rule; raise `rolesMaxReplicas` |

Setting `LLM_PROVIDER=local` on the roles app forces heuristics everywhere (a clean, explicit
degraded mode) while the incident lasts.

## Communicate

Tell supervisors drafts may need more editing during the incident; sign-off rules are
unchanged. After recovery, compare edit rates for the affected window.
