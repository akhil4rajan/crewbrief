# Architecture decision records

Significant design decisions, in [MADR](https://adr.github.io/madr/) format. Add a new record
for any decision that is hard to reverse or that a future contributor would otherwise question.
Copy the structure of an existing record, take the next number, and link it here.

| # | Decision | Status |
|---|---|---|
| [0001](0001-deterministic-orchestrator.md) | The orchestrator is a deterministic state machine, not an LLM | Accepted |
| [0002](0002-provider-abstraction-and-offline-local-mode.md) | Provider abstraction and an offline local mode with dummy credentials | Accepted |
| [0003](0003-dict-keyed-form-and-json-pointer-patches.md) | Dict-keyed form, JSON Pointer patches with provenance | Accepted |
| [0004](0004-rules-in-code-not-prompts.md) | Safety rules live in code, not prompts | Accepted |
| [0005](0005-transcription-in-the-gateway.md) | Transcription runs in the gateway process | Accepted |
| [0006](0006-realtime-fan-out-via-web-pubsub.md) | Real-time fan-out via Web PubSub with a negotiate endpoint | Accepted |
| [0007](0007-sqlite-locally-cosmos-in-azure.md) | SQLite locally, Cosmos DB in Azure, behind one repository interface | Accepted |
| [0008](0008-privacy-by-default.md) | Privacy: no raw audio, PII redaction, no voice biometrics | Accepted |
| [0009](0009-eval-gate-in-ci.md) | Eval gate in CI | Accepted |
