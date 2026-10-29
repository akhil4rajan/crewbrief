# 0008. Privacy: no raw audio, PII redaction, no voice biometrics

- Status: Accepted
- Date: 2026-10-29

## Context and problem statement

CrewBrief records workplace conversations. That brings workplace surveillance and
listening-device laws (which vary by Australian state), the Privacy Act, and the trust of the
crews themselves. Collecting less is the strongest control.

## Decision drivers

- Minimise personal information collected and retained
- Make the safe behaviour the default, not a configuration step
- Keep speaker attribution without biometric identification

## Considered options

1. Store audio and transcripts, restrict access
2. Store transcripts only, redacted, with retention limits; no audio; no voice prints

## Decision outcome

Chosen option 2.

- **No raw audio**: `RETAIN_RAW_AUDIO=false` by default; audio is streamed to Speech and dropped.
- **PII redaction**: every transcript segment is redacted in the gateway (Azure AI Language in
  Azure) before it is forwarded or stored (`PII_REDACTION=true`).
- **Retention**: transcript segments expire via Cosmos DB TTL (`transcriptRetentionDays`,
  default 90). Signed forms and the audit log follow the safety-record retention policy.
- **No voice biometrics**: speakers are linked to crew members through app check-in and
  diarization labels, never voice prints.
- **Consent and control**: crews are notified when recording is active (`/consent`), and can
  pause at any time.
- **Residency**: all resources are deployed to Australia East (enforced by the Bicep `location`
  parameter); global model deployment SKUs are not offered.

### Consequences

- Good: a breach exposes far less; deletion requests are tractable
  (`docs/runbooks/data-deletion-request.md`).
- Bad: no audio means a disputed transcript cannot be re-listened to.
- Bad: redaction can remove useful context (e.g. a street name for the site address); the
  form keeps site details from structured inputs instead.
