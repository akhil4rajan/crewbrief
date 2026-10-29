# Security policy

## Reporting a vulnerability

Please do not open a public issue. Email the maintainer (see `CODEOWNERS`) with a description, the
affected component and steps to reproduce. You will get an acknowledgement within two business days.

## How CrewBrief protects data

| Area | Control |
|---|---|
| Identity | Entra ID for people (`AUTH_MODE=entra`), managed identity for services; `/internal/*` routes are not exposed publicly |
| Authorisation | Role checks in code (`packages/common/auth.py`); sign-off rules in `packages/rules` (`can_sign_off`) |
| Secrets | Never in git. `.env` holds dummy values only; real keys go in `.env.local` (git-ignored) or Key Vault. A pre-commit hook and CI secret scan (gitleaks) enforce this |
| Network | Private endpoints and VNet integration; public network access disabled in Azure (see `infra/bicep`) |
| Data residency | All processing in Australia East |
| Audio | Raw audio is not stored (`RETAIN_RAW_AUDIO=false`) |
| Transcripts | PII redacted before storage (`PII_REDACTION=true`); retention deletion via `DELETE /api/sessions/{id}` (safety_admin), audit log kept |
| Logs | Structured JSON; bearer tokens are redacted from log lines |
| Audit | Append-only audit log: every field change records evidence, model and prompt version, and the reviewer's action |
| Voice | No voice biometrics; speakers are linked through app sign-in and context |

Runbooks: `docs/runbooks/secret-rotation.md`, `docs/runbooks/data-deletion-request.md`.
