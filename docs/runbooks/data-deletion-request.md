# Runbook: data deletion (erasure) request

Applies to requests from crew members or the employer to delete personal information, and to
retention-driven deletions. Involve the privacy officer before acting; a signed safety record
may itself be subject to a legal retention obligation that overrides erasure.

## What CrewBrief holds about a person

| Data | Where | Default retention |
|---|---|---|
| Name, email, role, crew | Entra ID (source of truth), copied into session participants | Owned by the identity team |
| Transcript segments (PII-redacted, speaker linked by check-in) | Cosmos DB `segments` | TTL `transcriptRetentionDays` (default 90 days) |
| Draft and revisions, gaps | Cosmos DB `drafts`, `draft_revisions`, `gaps` | Until deleted |
| Signed/submitted form | Cosmos DB and the downstream safety system | Safety-record policy |
| Audit log | Cosmos DB `audit` (append-only) | Retained; records the deletion itself |
| Raw audio | Not stored (ADR 0008) | n/a |
| Logs/telemetry | Log Analytics / Application Insights | Workspace retention (default 90 days); no transcript text is logged |

## Procedure

1. **Log the request** (ticket id, requester, scope, legal basis). Confirm identity.
2. **Find the sessions** the person took part in. As a `safety_admin`:
   ```bash
   curl -H "Authorization: Bearer $TOKEN" "$FORM_API/api/sessions?limit=500" \
     | jq -r '.[] | select(.participants[]?.user_id == "<user-id>") | .id'
   ```
   (or query Cosmos DB `sessions` for the user id from a VNet-connected machine).
3. **Check holds**: submitted forms may need to be kept. Agree with the privacy officer
   whether to delete the whole session or keep the signed form in the downstream system only.
4. **Delete each session** through the API, which hard-deletes transcript, drafts (with
   history), gaps and the session, and leaves a tombstone plus an audit entry:
   ```bash
   curl -X DELETE -H "Authorization: Bearer $TOKEN" \
     "$FORM_API/api/sessions/<session-id>?reason=erasure%20request%20<ticket>"
   ```
   The call is idempotent: retrying after an interruption completes the purge. Live sessions
   must be abandoned or finished first (`409 invalid_state`).
5. **Downstream**: raise the matching request with the owner of the downstream safety system.
6. **Backups**: Cosmos DB continuous backup keeps 7 days of history; deleted data ages out
   within 7 days. Note this in the response.
7. **Respond** with the list of sessions deleted (tombstones) and anything retained, with reasons.

The audit log keeps the fact that a session existed and was deleted (who, when, why), not its
content. That is deliberate: it is the evidence that the request was honoured.
