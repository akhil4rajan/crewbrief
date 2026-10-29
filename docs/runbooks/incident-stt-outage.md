# Runbook: speech-to-text outage or degradation

**Symptoms**: transcript segments stop arriving for audio sessions; gateway logs show
`stt_failed`, `stt_start_failed` or `stt_canceled` (ConversationTranscriber cancellations); Speech
metrics show 429s or 5xx; the live form stops updating while crews are still talking.

## Triage (first 10 minutes)

1. **Scope**: one session, one gateway replica, or all? In Application Insights:
   ```kusto
   traces
   | where timestamp > ago(30m) and cloud_RoleName == "crewbrief-gateway"
   | where message startswith "stt_"
   | summarize count() by message, bin(timestamp, 1m)
   ```
2. **Azure status**: Service Health for *Speech* in Australia East.
3. **Quota**: Speech resource → Metrics → *Throttled calls* and *Active connections*. Concurrent
   real-time sessions are capped per resource (default concurrency limit, raisable via support).
4. **Auth/network**: 401/403 means the gateway identity lost *Cognitive Services Speech User*
   or the private endpoint/DNS changed. Check `az role assignment list --scope <speech-id>`.

## Mitigate

- **Crews are not blocked**: the device protocol supports text mode. On STT errors the crew
  app falls back to on-device recognition and sends text segments; confirm in a test session.
  Briefings can always finish and be reviewed.
- **Throttling (429)**: lower the gateway's maximum replicas is *not* the fix; instead add a
  second Speech resource and route new sessions to it (see `scaling-morning-peak.md`), and
  request a concurrency increase.
- **Regional outage**: there is no cross-region failover by design (data residency). Announce
  text-mode operation to supervisors; do not point the gateway at a non-Australian region.
- **Bad deploy**: if errors started with a release, roll back the gateway revision (`deploy.md`).

## Recover and follow up

- Sessions stay in `BRIEFING`/`DRAFTING`; when STT returns, devices resume audio on reconnect.
- Sessions that were abandoned mid-outage can be resumed by a supervisor (`resume-briefing`).
- Post-incident: record time to detect, sessions affected, and whether the text fallback worked.
