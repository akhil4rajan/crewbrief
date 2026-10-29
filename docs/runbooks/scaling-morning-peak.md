# Runbook: scaling for the morning peak

Most briefings start between 06:30 and 08:00 local time. Each active briefing is one long-lived
device WebSocket, one Speech transcription stream, one orchestrator runner and periodic LLM
calls. Target: 1,000+ concurrent sessions with ~2 s speech-to-field latency.

## Capacity model (per 1,000 concurrent sessions)

| Resource | Driver | Planning number |
|---|---|---|
| Gateway | 1 device WS + ~2 live viewers per session (live viewers go to Web PubSub in Azure) | `gatewayConnectionsPerReplica` = 150 → ~7 replicas at 1 vCPU (audio relay is CPU-bound) |
| Speech | 1 concurrent real-time stream per audio session | Above the default per-resource concurrency: request an increase and/or add resources |
| Azure OpenAI | Analyst + form filler every `EXTRACTION_INTERVAL_SECONDS` (8 s); verifier every 3rd extraction | ~250 calls/s peak at 8 s cadence across roles; size TPM or PTU from the eval's token counts |
| Roles | I/O bound on LLM calls | `concurrentRequests` = 20 per replica → up to `rolesMaxReplicas` |
| Web PubSub | ~3 client connections per session | 1 unit = 1,000 connections → 3+ units (`webPubSubCapacity`) |
| Cosmos DB | Small per-session writes | Serverless is fine for pilots; switch to provisioned autoscale (`cosmosCapacityMode`) for predictable cost at scale |

## Before the peak (weekly)

- Pre-warm: raise `gatewayMinReplicas` and `rolesMinReplicas` for the peak window with a
  scheduled scale (KEDA `cron` rule) or by setting min replicas the night before. Cold starts
  during the first wave are the main latency risk.
- Check Speech, OpenAI and Web PubSub quotas against last week's peak plus 30%.

## Azure OpenAI: Standard vs PTU

- Standard (regional) is pay-as-you-go but shares capacity: 429s and latency spikes appear
  exactly at the peak.
- **Provisioned throughput (PTU)** (`MODEL_DEPLOYMENT_SKU=ProvisionedManaged`, capacity in
  PTUs) gives predictable latency. Size the extractor deployment for the peak and keep the
  verifier on a smaller PTU deployment or Standard (it runs at milestones only).
- Global and data-zone SKUs are not used: they may process data outside Australia.
- Watch *Provisioned-managed utilization*; above ~90% sustained, add PTUs or lengthen the
  extraction interval. Roles fall back to heuristics on timeout (`incident-llm-degraded.md`).

## Speech: multiple resources behind a router

One Speech resource has a concurrency ceiling for real-time transcription. To go beyond it:

1. Deploy additional Speech resources in Australia East (copy the `speech` module in
   `main.bicep` with a suffix; grant the gateway identity *Cognitive Services Speech User* on each).
2. Configure the gateway's transcriber with the list of endpoints and assign each new session
   to the least-loaded resource (session-sticky: a stream never moves mid-briefing).
3. Alert on per-resource throttling and active connections.

## KEDA scale rules (Container Apps)

| App | Rule | Min / max (defaults) |
|---|---|---|
| gateway | HTTP concurrency, named `websocket-connections`; each open WebSocket counts as a concurrent request | 2 / 20 |
| form-api | HTTP concurrency 80 | 2 / 10 |
| roles | HTTP concurrency 20 | 1 / 20 |
| orchestrator | HTTP concurrency 200 | 1 / 1 (see below) |
| review-portal | HTTP concurrency 100 | 1 / 5 |

Scale-in drains WebSockets: devices reconnect automatically and resume (the session state is
in the form API). Keep the gateway's scale-in conservative during the peak (raise min replicas).

## Orchestrator scale-out

Per-session runners live in orchestrator memory, and `/internal/sessions/{id}/*` calls must
reach the replica that owns the session. Until session-affine routing exists (consistent
hashing on session id, or one runner per session via an actor framework), keep
`orchestratorMaxReplicas` at 1 and scale it **vertically** (CPU/memory in `main.bicep`).
A single replica handles the scheduling for many sessions because the work is I/O bound;
watch event-loop lag and tick timings in `/internal/sessions/{id}/status`.

## Signals to watch during the peak

- Gateway: active connections per replica, CPU, `stt_*` errors.
- Roles: request duration p95 vs the extraction interval; heuristic fallbacks.
- OpenAI: 429 rate, PTU utilisation. Speech: throttled calls.
- End to end: time from segment to `form.patched` event (Application Insights dependency chain).
