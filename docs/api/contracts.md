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
| review-portal | 3000 | web app: crew briefing view (`/crew`) and crew lead review (`/sessions`) |

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
| POST | `/api/sessions` | `CreateSessionRequest` (`crew_member_ids` optional) → `SessionDetail`. The creator is the **crew lead**: if they have the crew role they are added to `crew_member_ids` and `form.crew` (role `leading_hand`, checked in) | crew, supervisor |
| GET | `/api/sessions?state=REVIEW&mine=true` | → `Session[]` (newest first) | any |
| GET | `/api/sessions/{id}` | → `SessionDetail` | any |
| POST | `/api/sessions/{id}/check-in` | `{user_id?}` (defaults to caller) → `SessionDetail` (kept for compatibility; not required) | crew |
| POST | `/api/sessions/{id}/consent` | → `Session` (records recording consent notice) | crew |
| POST | `/api/sessions/{id}/start` | → `Session` (CREATED→BRIEFING, notifies orchestrator; 409 `consent_required` until `/consent` is recorded) | crew |
| POST | `/api/sessions/{id}/end-briefing` | → `Session`, returned as soon as the orchestrator has run the final extraction + verifier (never waits for answers): `REVIEW` when there are no critical gaps, else `GAP_CHECK` with `clarifications` populated (see Standup mode). Orchestrator unreachable: rules → gaps → `REVIEW` locally | crew, supervisor |
| POST | `/api/sessions/{id}/finish-clarifications` | → `Session` (GAP_CHECK→REVIEW; open clarifications become `skipped` and their gaps stay open for review) | crew on the job, supervisor |
| POST | `/api/sessions/{id}/resume-briefing` | → `Session` (REVIEW→DRAFTING) | crew lead, supervisor, safety_admin |
| POST | `/api/sessions/{id}/acknowledge` | → `SessionDetail` (caller confirms they read the form; REVIEW/SIGNED/SUBMITTED) | crew on the job |
| GET | `/api/sessions/{id}/draft` | → `Draft` | any |
| PATCH | `/api/sessions/{id}/draft` | `ApplyPatchesRequest` (human edits, `provenance.source="human"` forced server-side) → `ApplyPatchesResult` | crew lead (until SIGNED), crew on the job (pre-REVIEW), supervisor |
| GET | `/api/sessions/{id}/transcript` | → `TranscriptSegment[]` | any |
| GET | `/api/sessions/{id}/gaps` | → `Gap[]` | any |
| GET | `/api/sessions/{id}/speakers` | → `[{speaker_id, label, user_id?, name?, segment_count}]` in order of first appearance; diarized ids (`Guest-N`) are labelled `Speaker 1`, `Speaker 2`… | any |
| PUT | `/api/sessions/{id}/speakers/{speaker_id}` | `{user_id?, name?}` (at least one) → speakers list. Relabels that voice's stored segments (`user_id`, `speaker_name`) and later ones, adds the person to `form.crew` (key `user_id`, or `speaker:{speaker_id}` for a name only), publishes `session.updated` | crew on the job, supervisor (until SIGNED) |
| POST | `/api/sessions/{id}/gaps/{gap_id}/dismiss` | `{reason}` → `Gap` | crew lead, supervisor, safety_admin |
| POST | `/api/sessions/{id}/sign-off` | `SignOffRequest` → `Session` (REVIEW→SIGNED; blocking gaps need a fix or an override with justification) | crew lead, safety_admin (rules: `can_sign_off`) |
| POST | `/api/sessions/{id}/submit` | → `Session` (SIGNED→SUBMITTED, downstream adapter) | crew lead, safety_admin |
| POST | `/api/sessions/{id}/abandon` | `AbandonRequest` → `Session` | crew, supervisor |
| GET | `/api/sessions/{id}/audit` | → `AuditEntry[]` | supervisor, safety_admin |
| GET | `/api/sessions/{id}/diff` | → `{ai_revision, final_revision, changes: [{path, op, before, after, role}]}` | supervisor, safety_admin |
| GET | `/api/metrics/edit-rate` | → `{sessions, fields: [{path_pattern, ai_filled, edited, edit_rate}], roles: [...]}` | supervisor, safety_admin |
| GET | `/api/library` | → `HazardLibrary` (for pickers) | any |
| DELETE | `/api/sessions/{id}?reason=` | → `Tombstone` (retention / erasure: purges transcript, drafts, gaps; audit kept) | safety_admin |

`SessionDetail = {session: Session, draft: Draft, gaps: Gap[], transcript_count: int, risk: {hazard_code: HazardRisk}}`

### Risk matrix (`risk`)

Computed in code (`packages/rules/risk.py`) on every `GET /api/sessions/{id}` and included in the
submission payload; the AI never scores risk. 5×5 likelihood × consequence (AS/NZS ISO 31000 style):
`HazardRisk = {before: RiskScore, after: RiskScore, basis: str}`,
`RiskScore = {likelihood: 1-5, consequence: 1-5, score: 1-25, level: "low"|"medium"|"high"|"extreme"}`
(score 1-4 low, 5-9 medium, 10-16 high, 20-25 extreme).

* **Before** (inherent) from library severity → (likelihood, consequence): critical (3, 5), high (3, 4),
  medium (3, 3), low (2, 2).
* **After** (residual) applies the single most effective *confirmed* control (`planned`/`in_place`;
  `proposed` suggestions do not count): elimination → (1, 1); substitution likelihood −2 and
  consequence −1; isolation / engineering likelihood −2; administrative likelihood −1; PPE
  consequence −1. Floor 1. No confirmed control → after = before. `basis` names the control used.

**Crew lead** = the user who created the session (`session.created_by`). There is no supervisor step in
the flow: the crew lead reviews, fixes, signs off and submits (`supervisor_id` is optional and unused).

`Session` also carries `clarifications: Clarification[]` and `speaker_assignments: {speaker_id: {user_id?, name}}`.
`Clarification = {gap_id, question, status: "open"|"answered"|"skipped", asked_at, answered_at?}`.

### Standup mode (end-of-briefing clarifications)

CrewBrief never interrupts while the briefing is live (BRIEFING/DRAFTING): no `voice.prompt` events;
the verifier still runs on milestones so gaps stay visible. On end-briefing the orchestrator runs the
final extraction + verifier, then picks the critical clarifications: open **blocking** gaps, most
severe first, at most 3.

* None → `REVIEW`.
* Otherwise the session stays in `GAP_CHECK` with `session.clarifications` set (`session.updated`), and
  each question is published once as a `voice.prompt` event (`VoicePrompt`; `audio_b64` in azure mode),
  in order. The device keeps streaming answers (audio or text) on the same device socket; each answer
  batch is extracted (the analyst sees the open gaps) and re-verified. A clarification becomes
  `answered` when its gap resolves; when none are open the session moves to `REVIEW` automatically.
* `finish-clarifications` ("Done") moves to `REVIEW` at any time; remaining questions become `skipped`.

Internal (`/internal`, `X-Internal-Token`), used by the orchestrator:

| Method | Path | Body → Response |
|---|---|---|
| GET | `/internal/sessions/{id}/context?transcript_limit=200` | → `{session, draft, gaps, transcript: TranscriptSegment[]}` |
| POST | `/internal/sessions/{id}/segments` | `{segments: TranscriptSegment[]}` → `{stored: int}` (assigns nothing; orchestrator sets `seq`) |
| POST | `/internal/sessions/{id}/patches` | `ApplyPatchesRequest` (AI patches) → `ApplyPatchesResult` |
| PUT | `/internal/sessions/{id}/gaps` | `{gaps: Gap[]}` → `Gap[]` (upsert by stable id; human-dismissed gaps stay dismissed) |
| PUT | `/internal/sessions/{id}/clarifications` | `{clarifications: Clarification[]}` → `Session` (replaces the list; publishes `session.updated`) |
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
| POST | `/internal/sessions/{id}/end` | → `{state, settled}` (final extraction + verifier, then REVIEW or the clarification round; waits ≤ 40 s, never for answers) |
| POST | `/internal/sessions/{id}/finish` | → `{state, settled}` (extract pending answers, re-verify, GAP_CHECK→REVIEW) |
| POST | `/internal/sessions/{id}/recording` | `{recording}` → `{}` (pause/resume from device) |
| POST | `/internal/sessions/{id}/resume` | → `{}` (REVIEW→DRAFTING, resume scheduling) |
| GET | `/internal/sessions/{id}/status` | → runner status (state, ticks, last run timings) |

The orchestrator publishes `voice.prompt` events (payload `VoicePrompt`) directly, only when the
clarification round starts (one per question, in order).

It also publishes an `agent.activity` event (best-effort) around every role call: `started` just
before the call, then `done` or `failed`. Payload:

```jsonc
{"role": "conversation-analyst" | "hazard-expert" | "form-filler" | "verifier" | "voice-prompter",
 "status": "started" | "done" | "failed",
 "step": "live" | "final" | "answers" | "verify" | "clarify",   // why it ran
 "tick": 3, "summary": "Heard 4 lines, found 3 hazards and 2 controls; ignored 1 off-topic line",
 "provider": "azure-openai" | "heuristic" | "heuristic-fallback" | null,   // null on started/failed
 "model": "...", "prompt_version": "...", "latency_ms": 412,
 "counts": {"lines": 4, "observations": 5, "dropped": 1}}   // empty on started/failed
```

`counts` per role on `done`: analyst `{lines, observations, dropped}`; hazard expert
`{hazards, task_typical, controls}`; form filler `{patches, rejected}` (rejected = stopped by the
safety rules); verifier `{open, blocking, resolved}`; voice prompter `{questions}`.

Each `done`/`failed` call is also audited as `role.invoked` with details `{role, status, step, tick,
summary, counts, provider, latency_ms, tokens_in, tokens_out}` (+ `error` when failed), so
`GET /api/sessions/{id}/audit` filtered on `action == "role.invoked"` is the full agent timeline.

## Roles (port 8003) — internal only

`POST /roles/conversation-analyst`, `/roles/hazard-expert`, `/roles/form-filler`,
`/roles/verifier`, `/roles/voice-prompter` with the request/response models in
`packages/schemas/roles.py`. In-process equivalents: `services.roles.registry.ROLE_HANDLERS[RoleName]`
(async callables `request -> response`).

## Gateway (port 8000)

| Kind | Path | Notes |
|---|---|---|
| GET | `/api/sessions/{id}/negotiate` (bearer) | → `{url}`: local `ws://…/ws/live/{id}?access_token=…`; Azure: Web PubSub client URL joined to group `session.{id}` |
| WS | `/ws/live/{session_id}?access_token=` | server → client `EventEnvelope` JSON messages (read-only subscribers: crew and supervisor views) |
| WS | `/ws/device/{session_id}?access_token=` | crew device audio/text stream (protocol below) |
| POST | `/api/sessions/{id}/recording` (bearer, crew on the job) | multipart `file` (wav/mp3/m4a/ogg/webm, ≤ 100 MB) → `{segments, duration_ms}`. Session must be BRIEFING/DRAFTING. Azure AI Speech fast transcription (`en-AU`, diarization up to 8 speakers) → `Guest-N` segments, PII-redacted and filtered like live ones, forwarded to the orchestrator, then the briefing is ended (clarification round). Audio stays in memory. Local mode → 501 `stt_unavailable_local`; Speech auth failure → 502 `stt_auth_failed`; 413 over the size limit |
| POST | `/internal/events` | `EventEnvelope` → fan out to `/ws/live` + `/ws/device` subscribers of that session |

### Device WebSocket protocol (`/ws/device/{session_id}`)

Client → server (JSON text frames unless noted):

```jsonc
{"type": "start", "mode": "audio" | "text", "sample_rate": 16000, "encoding": "pcm16", "device_id": "..."}
// binary frames: raw PCM16 LE mono at sample_rate (only after start with mode "audio"; VAD-gated on device)
{"type": "transcript", "text": "...", "speaker_user_id": "u-crew-1", "confidence": 0.92,
 "start_ms": 1200, "end_ms": 3400}   // text mode: on-device recognition or typed input
// instead of speaker_user_id a device may send "speaker_label": "Speaker 2" (becomes the segment's speaker_id)
{"type": "pause"}  {"type": "resume"}  {"type": "end"}  {"type": "ping"}
```

Server → client: `{"type": "ready", "session_id", "mode"}`, `{"type": "pong"}`, and every
`EventEnvelope` for the session (the device plays `voice.prompt` events: `audio_b64` if present,
otherwise on-device TTS of `text`).

After `end`, if the session enters the clarification round (`GAP_CHECK`), the socket stays usable:
keep sending `transcript` messages (or audio; the gateway restarts the transcriber) with the crew's
answers until the session reaches `REVIEW`.

In `audio` mode the gateway streams frames to the transcriber (`services.transcription`):
Azure `ConversationTranscriber` (STT + diarization) in azure mode. In local mode audio frames are
accepted but cannot be transcribed, so the gateway replies with an `error` event
`{"code": "stt_unavailable_local"}` once and the client should switch to `text` mode.
