# 0002. Provider abstraction and an offline local mode with dummy credentials

- Status: Accepted
- Date: 2026-10-29

## Context and problem statement

CrewBrief depends on seven Azure services (Speech, OpenAI, Voice Live, AI Search, Cosmos DB,
Web PubSub, AI Language). Requiring all of them to run the code would slow every contributor,
make CI depend on cloud credentials, and tempt people to commit real keys.

## Decision drivers

- `git clone && docker compose up` must work with no Azure account
- CI must run the full loop and the eval without secrets
- No real secrets in the repository, ever
- Production code paths must be the same code, not a fork

## Considered options

1. Require Azure for development; mock in unit tests only
2. Emulators (Cosmos emulator, Azurite) plus real AI services
3. Small Protocols per integration with a local and an Azure implementation, selected by config

## Decision outcome

Chosen option 3. `CREWBRIEF_MODE=local|azure` selects the default provider; `*_PROVIDER`
overrides one integration (e.g. only `LLM_PROVIDER=azure`). Azure SDKs are imported lazily
inside the Azure implementations, so local mode does not need the `azure` extra.

The committed `.env` holds dummy values only. Any value containing `dummy` is treated as unset
(`Settings.is_dummy`), so a dummy key never reaches an SDK; Azure implementations then use
`DefaultAzureCredential`. Real keys, if needed for local experiments, go in the uncommitted
`.env.local`. A pre-commit hook and the CI secret scan enforce this.

### Consequences

- Good: zero-setup local runs; CI exercises the whole pipeline offline and deterministically.
- Good: managed identity is the default in Azure; keys are an opt-in local convenience.
- Bad: local stand-ins (heuristic roles, local search) behave differently from the real
  services, so eval numbers in local mode measure the pipeline, not the models.
- Bad: two implementations per integration to maintain.
