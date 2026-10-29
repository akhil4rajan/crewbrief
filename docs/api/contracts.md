# Service contracts

All payload models live in `packages/schemas` (Pydantic v2). JSON Schema for TypeScript clients
is exported to `packages/schemas/jsonschema/` by `python -m packages.schemas.export`.
Errors are RFC 7807 `application/problem+json` everywhere.

## Ports (local)

| Service | Port | Public surface |
|---|---|---|
| gateway | 8000 | device + live WebSockets, negotiate |
| form-api | 8001 | REST API for both frontends |
| orchestrator | 8002 | internal only |
| roles | 8003 | internal only |
| review-portal | 3000 | supervisor web app |
| mobile (Expo web) | 8081 | crew app |

## Authentication

* Users: `Authorization: Bearer <jwt>`. WebSockets pass `?access_token=<jwt>`.
  Local: `POST /api/auth/dev-token {"user_id": "u-sup-1"}` on the form API returns
  `{"access_token", "token_type": "bearer", "user": User}` (only when `AUTH_MODE=dev`).
* Services: `/internal/*` requires header `X-Internal-Token: $INTERNAL_SERVICE_TOKEN`.
* Seeded users (local): `u-crew-1` Sam Taylor, `u-crew-2` Priya Nair, `u-crew-3` Jack O'Brien,
  `u-crew-4` Mei Chen (roles `crew`), `u-sup-1` Alex Morgan, `u-sup-2` Jordan Lee (`supervisor`),
  `u-admin-1` Casey Brooks (`safety_admin`).

## Form API (port 8001) — owns sessions, drafts, transcript, gaps, audit

Public (`/api`, bearer token):

| Method | Path | Body → Response | Who |
|---|---|---|---|
| POST | `/api/auth/dev-token` | `{user_id}` → `{access_token, token_type, user}` | anyone (dev only) |
| GET | `/api/auth/dev-users` | → `User[]` | anyone (dev only) |
| GET | `/api/me` | → `User` | any |
| GET | `/api/users?role=crew` | → `User[]` | any |
| POST | `/api/sessions` | `CreateSessionRequest` → `SessionDetail` | crew, supervisor |
| GET | `/api/sessions?state=REVIEW&mine=true` | → `Session[]` (newest first) | any |
| GET | `/api/sessions/{id}` | → `SessionDetail` | any |
| POST | `/api/sessions/{id}/check-in` | `{user_id?}` (defaults to caller) → `SessionDetail` | crew |
| POST | `/api/sessions/{id}/consent` | → `Session` (records recording consent notice) | crew |
| POST | `/api/sessions/{id}/start` | → `Session` (CREATED→BRIEFING, notifies orchestrator; 409 `consent_required` until `/consent` is recorded) | crew |
| POST | `/api/sessions/{id}/end-briefing` | → `Session` (orchestrator runs final extraction + verifier, then GAP_CHECK→REVIEW) | crew, supervisor |
| POST | `/api/sessions/{id}/resume-briefing` | → `Session` (REVIEW→DRAFTING) | supervisor |
| POST | `/api/sessions/{id}/acknowledge` | → `SessionDetail` (caller confirms they read the form; REVIEW/SIGNED/SUBMITTED) | crew on the job |
| GET | `/api/sessions/{id}/draft` | → `Draft` | any |
| PATCH | `/api/sessions/{id}/draft` | `ApplyPatchesRequest` (human edits, `provenance.source="human"` forced server-side) → `ApplyPatchesResult` | crew (pre-REVIEW), supervisor |
| GET | `/api/sessions/{id}/transcript` | → `TranscriptSegment[]` | any |
| GET | `/api/sessions/{id}/gaps` | → `Gap[]` | any |
| POST | `/api/sessions/{id}/gaps/{gap_id}/dismiss` | `{reason}` → `Gap` | supervisor |
| POST | `/api/sessions/{id}/sign-off` | `SignOffRequest` → `Session` (REVIEW→SIGNED) | supervisor (rules: `can_sign_off`) |
| POST | `/api/sessions/{id}/submit` | → `Session` (SIGNED→SUBMITTED, downstream adapter) | supervisor |
| POST | `/api/sessions/{id}/abandon` | `AbandonRequest` → `Session` | crew, supervisor |
| GET | `/api/sessions/{id}/audit` | → `AuditEntry[]` | supervisor, safety_admin |
| GET | `/api/sessions/{id}/diff` | → `{ai_revision, final_revision, changes: [{path, op, before, after, role}]}` | supervisor, safety_admin |
| GET | `/api/metrics/edit-rate` | → `{sessions, fields: [{path_pattern, ai_filled, edited, edit_rate}], roles: [...]}` | supervisor, safety_admin |
| GET | `/api/library` | → `HazardLibrary` (for pickers) | any |
| DELETE | `/api/sessions/{id}?reason=` | → `Tombstone` (retention / erasure: purges transcript, drafts, gaps; audit kept) | safety_admin |

`SessionDetail = {session: Session, draft: Draft, gaps: Gap[], transcript_count: int}`

Internal (`/internal`, `X-Internal-Token`), used by the orchestrator:

| Method | Path | Body → Response |
|---|---|---|
| GET | `/internal/sessions/{id}/context?transcript_limit=200` | → `{session, draft, gaps, transcript: TranscriptSegment[]}` |
| POST | `/internal/sessions/{id}/segments` | `{segments: TranscriptSegment[]}` → `{stored: int}` (assigns nothing; orchestrator sets `seq`) |
| POST | `/internal/sessions/{id}/patches` | `ApplyPatchesRequest` (AI patches) → `ApplyPatchesResult` |
| PUT | `/internal/sessions/{id}/gaps` | `{gaps: Gap[]}` → `Gap[]` (upsert by stable id; human-dismissed gaps stay dismissed) |
| POST | `/internal/sessions/{id}/transition` | `TransitionRequest` → `Session` |
| POST | `/internal/sessions/{id}/recording` | `{recording: "active"\|"paused"\|"idle"}` → `Session` |
| POST | `/internal/sessions/{id}/audit` | `AuditEntry` → `{}` (role invocations, voice prompts) |
| GET | `/internal/sessions?state=BRIEFING,DRAFTING,GAP_CHECK` | → `Session[]` (orchestrator recovery after restart) |

The form API publishes these events after each commit: `session.state_changed`,
`session.updated`, `recording.changed`, `transcript.segment` (one per stored segment),
`form.patched`, `gaps.updated`, `presence.updated`.

## Orchestrator (port 8002) — internal only

| Method | Path | Body → Response |
|---|---|---|
| POST | `/internal/sessions/{id}/start` | → `{}` (begin scheduling; idempotent) |
| POST | `/internal/sessions/{id}/segments` | `{segments: TranscriptSegment[]}` → `{accepted: int}` (from gateway) |
| POST | `/internal/sessions/{id}/end` | → `{}` (final extraction + verifier, then REVIEW) |
| POST | `/internal/sessions/{id}/recording` | `{recording}` → `{}` (pause/resume from device) |
| POST | `/internal/sessions/{id}/resume` | → `{}` (REVIEW→DRAFTING, resume scheduling) |
| GET | `/internal/sessions/{id}/status` | → runner status (state, ticks, last run timings) |

The orchestrator publishes `voice.prompt` events (payload `VoicePrompt`) directly.

## Roles (port 8003) — internal only

`POST /roles/conversation-analyst`, `/roles/hazard-expert`, `/roles/form-filler`,
`/roles/verifier`, `/roles/voice-prompter` with the request/response models in
`packages/schemas/roles.py`. In-process equivalents: `services.roles.registry.ROLE_HANDLERS[RoleName]`
(async callables `request -> response`).

## Gateway (port 8000)

| Kind | Path | Notes |
|---|---|---|
| GET | `/api/sessions/{id}/negotiate` (bearer) | → `{url}`: local `ws://…/ws/live/{id}?access_token=…`; Azure: Web PubSub client URL joined to group `session.{id}` |
| WS | `/ws/live/{session_id}?access_token=` | server → client `EventEnvelope` JSON messages (read-only subscribers: portal, crew app) |
| WS | `/ws/device/{session_id}?access_token=` | crew device audio/text stream (protocol below) |
| POST | `/internal/events` | `EventEnvelope` → fan out to `/ws/live` + `/ws/device` subscribers of that session |

### Device WebSocket protocol (`/ws/device/{session_id}`)

Client → server (JSON text frames unless noted):

```jsonc
{"type": "start", "mode": "audio" | "text", "sample_rate": 16000, "encoding": "pcm16", "device_id": "..."}
// binary frames: raw PCM16 LE mono at sample_rate (only after start with mode "audio"; VAD-gated on device)
{"type": "transcript", "text": "...", "speaker_user_id": "u-crew-1", "confidence": 0.92,
 "start_ms": 1200, "end_ms": 3400}   // text mode: on-device recognition or typed input
{"type": "pause"}  {"type": "resume"}  {"type": "end"}  {"type": "ping"}
```

Server → client: `{"type": "ready", "session_id", "mode"}`, `{"type": "pong"}`, and every
`EventEnvelope` for the session (the device plays `voice.prompt` events: `audio_b64` if present,
otherwise on-device TTS of `text`).

In `audio` mode the gateway streams frames to the transcriber (`services.transcription`):
Azure `ConversationTranscriber` (STT + diarization) in azure mode. In local mode audio frames are
accepted but cannot be transcribed, so the gateway replies with an `error` event
`{"code": "stt_unavailable_local"}` once and the client should switch to `text` mode.
