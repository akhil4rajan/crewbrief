# Architecture

This page describes how CrewBrief is put together: the components, how one briefing flows
through them, how sign-off works, and how the same code runs offline on a laptop and on Azure.
Service contracts are in [`docs/api/contracts.md`](api/contracts.md). Decisions behind the design
are recorded as ADRs in [`docs/adr/`](adr/).

## Components

```mermaid
flowchart LR
    subgraph Clients
        APP[Crew app<br/>apps/mobile]
        PORTAL[Review portal<br/>apps/review-portal]
    end

    subgraph Backend["Backend (one image, SERVICE selects the entrypoint)"]
        GW[Gateway :8000<br/>WebSockets, transcription,<br/>PII redaction, negotiate]
        ORCH[Orchestrator :8002<br/>per-session state machine]
        ROLES[Roles :8003<br/>analyst, hazard expert,<br/>form filler, verifier, voice prompter]
        FAPI[Form API :8001<br/>sessions, drafts, gaps,<br/>sign-off, audit]
    end

    subgraph Azure["Azure (CREWBRIEF_MODE=azure)"]
        SPEECH[AI Speech]
        AOAI[Azure OpenAI<br/>extractor + verifier]
        VL[Voice Live]
        SEARCH[(AI Search<br/>hazard library)]
        COSMOS[(Cosmos DB)]
        WPS[Web PubSub]
        LANG[AI Language<br/>PII]
    end

    APP -- device WS: audio or text --> GW
    GW -- segments --> ORCH
    ORCH -- role calls --> ROLES
    ORCH -- context, patches, gaps, transitions --> FAPI
    APP & PORTAL -- REST --> FAPI
    APP & PORTAL -- live events --> WPS
    GW --> SPEECH
    GW --> LANG
    ROLES --> AOAI
    ROLES --> SEARCH
    ROLES --> VL
    FAPI --> COSMOS
    FAPI -- events --> WPS
    ORCH -- voice.prompt --> WPS
```

| Component | Owns | Does not own |
|---|---|---|
| Gateway | Device and live WebSockets, speech-to-text, PII redaction of every segment, Web PubSub negotiate | Session state, persistence |
| Orchestrator | When each role runs, extraction cadence, verifier milestones, voice-prompt cooldown, state transitions it drives | Storage (calls the form API), language understanding |
| Roles | The narrow LLM jobs, each with a deterministic heuristic fallback | Scheduling, persistence, rules |
| Form API | Sessions, drafts and revisions, transcript, gaps, sign-off, submission, audit log, event publishing after each commit | Deciding what to extract |
| `packages/rules` | Safety rules in code: schema validation, critical-hazard controls, code mapping, sign-off permissions | |

## Live loop (one briefing)

```mermaid
sequenceDiagram
    autonumber
    participant D as Crew device
    participant G as Gateway
    participant O as Orchestrator
    participant R as Roles
    participant F as Form API
    participant P as Web PubSub / live WS
    participant S as Supervisor portal

    D->>F: POST /api/sessions, check-in, consent, start
    F->>O: /internal/sessions/{id}/start
    D->>G: WS /ws/device/{id} {"type":"start"}
    loop while briefing
        D->>G: PCM16 frames (VAD-gated) or text segments
        G->>G: Speech STT + diarization, confidence filter, PII redaction
        G->>O: POST /internal/sessions/{id}/segments
        O->>F: store segments
        F-->>P: transcript.segment
        Note over O: every EXTRACTION_INTERVAL_SECONDS
        O->>R: conversation-analyst -> hazard-expert -> form-filler
        O->>F: POST /internal/sessions/{id}/patches (JSON Pointer + provenance)
        F-->>P: form.patched
        Note over O: every Nth extraction (milestone)
        O->>R: verifier (LLM) + rules engine
        O->>F: PUT gaps
        F-->>P: gaps.updated
        O->>R: voice-prompter (highest-priority open gap, cooldown)
        O-->>P: voice.prompt
        P-->>D: plays the question
    end
    P-->>S: same events, live form view
```

The analyst and form filler are the only roles on the hot path. The verifier runs at
milestones and at the end of the briefing, which keeps LLM traffic bounded as sessions grow.

## Review and sign-off

```mermaid
sequenceDiagram
    autonumber
    participant C as Crew
    participant F as Form API
    participant O as Orchestrator
    participant S as Supervisor
    participant X as Downstream safety system

    C->>F: POST end-briefing
    F->>O: /internal/sessions/{id}/end
    O->>O: final extraction + verifier
    O->>F: transition GAP_CHECK -> REVIEW
    S->>F: GET draft, gaps, transcript evidence
    S->>F: PATCH draft (provenance.source = human), dismiss gaps with reason
    S->>F: POST sign-off
    F->>F: rules.can_sign_off (role, open critical gaps, schema)
    F->>F: REVIEW -> SIGNED, audit entry
    S->>F: POST submit
    F->>X: submission adapter
    F->>F: SIGNED -> SUBMITTED, AI-vs-final diff kept for edit-rate metrics
```

Session states: `CREATED → BRIEFING → DRAFTING ⇄ GAP_CHECK → REVIEW → SIGNED → SUBMITTED`,
with `ABANDONED` reachable before sign-off. The form is never submitted without a supervisor.

## Modes: local and Azure

Every integration sits behind a small Protocol with a local and an Azure implementation
(ADR 0002). `CREWBRIEF_MODE` picks the default; `*_PROVIDER` overrides one integration.

| Integration | `local` | `azure` |
|---|---|---|
| Speech-to-text | Not available; devices send text segments | Azure AI Speech `ConversationTranscriber` |
| LLM roles | Deterministic heuristics | Azure OpenAI deployments `extractor`, `verifier` |
| Hazard search | Local index of `knowledge/sources` | Azure AI Search (semantic) |
| Store | SQLite in `./var` | Cosmos DB, one container per collection, `/session_id` partition |
| Live updates | Gateway `/ws/live` fan-out | Azure Web PubSub group `session.<id>` |
| Voice prompts | Text, spoken by the device's TTS | Voice Live API |
| PII redaction | Local stand-in | Azure AI Language |
| Auth | Dev HS256 tokens for seeded users | Entra ID |

`python scripts/check_env.py` prints the resolved provider per integration without showing secrets.

## Ports

| Service | Local port | Azure ingress |
|---|---|---|
| gateway | 8000 | external (devices, negotiate) |
| form-api | 8001 | external (`/api`); `/internal` requires the internal token |
| orchestrator | 8002 | internal only |
| roles | 8003 | internal only |
| review-portal | 3000 (container listens on 8080) | external |
| mobile (Expo web) | 8081 | n/a |

## Azure deployment

`infra/bicep/main.bicep` provisions one resource group in Australia East:

- **Compute**: a VNet-integrated Container Apps environment with five apps and a manual ingest
  job. KEDA HTTP rules scale each app; the gateway scales on concurrent WebSocket connections.
- **Identity**: one user-assigned managed identity per workload, each with only the roles it
  needs. Key/local auth is disabled on Speech, OpenAI, Language, Search, Cosmos DB and Web PubSub.
- **Network**: data planes are reached through private endpoints and private DNS zones. Web PubSub
  keeps its public endpoint for client connections only; REST and server connections are private.
- **Secrets**: Key Vault (RBAC, purge protection). The only application secret is the internal
  service token, referenced by the container apps rather than copied into app settings.
- **Observability**: Log Analytics + Application Insights (OpenTelemetry). Every resource sends
  diagnostics to the workspace.

See [`runbooks/deploy.md`](runbooks/deploy.md) for provisioning and
[`runbooks/scaling-morning-peak.md`](runbooks/scaling-morning-peak.md) for capacity.
