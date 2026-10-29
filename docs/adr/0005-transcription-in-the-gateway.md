# 0005. Transcription runs in the gateway process

- Status: Accepted
- Date: 2026-10-29

## Context and problem statement

Audio arrives over the device WebSocket at the gateway. It must reach Azure AI Speech
(`ConversationTranscriber`, with diarization) with minimal delay, and transcripts must be
filtered and PII-redacted before they go anywhere else. A separate transcription service
would add a network hop for a continuous 16 kHz stream and a second long-lived connection per
session.

## Decision drivers

- Latency: speech to on-screen field in about two seconds
- Raw audio should cross as few process boundaries as possible (ADR 0008)
- One long-lived connection per session to scale and reason about

## Considered options

1. Separate transcription microservice receiving audio from the gateway
2. Transcription library (`services/transcription`) hosted in the gateway process
3. Device-side STT only

## Decision outcome

Chosen option 2. `services/transcription` is a library with a Protocol and local/Azure
implementations; the gateway owns one transcriber per audio session, applies the confidence
filter and PII redaction, and forwards text segments to the orchestrator. Audio never leaves
the gateway except to Azure Speech, and is not stored. Devices can also send text segments
(on-device recognition or typed input), which is the only option in local mode.

### Consequences

- Good: no extra hop; raw audio has the smallest possible footprint.
- Good: the gateway scales on connections, which is also what drives Speech concurrency.
- Bad: gateway replicas are CPU-heavier; size them for audio work, not just WebSockets.
- Bad: Speech quotas are per resource; scaling beyond one resource needs routing
  (see `docs/runbooks/scaling-morning-peak.md`).
