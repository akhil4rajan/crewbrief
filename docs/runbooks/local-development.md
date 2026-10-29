# Runbook: local development

Everything runs offline by default (`CREWBRIEF_MODE=local`, dummy values in `.env`).

## Prerequisites

Python 3.12+, [uv](https://docs.astral.sh/uv/), Node 20+, Docker (optional), GNU make.

## Option A: processes with auto-reload

```bash
make setup        # .venv with the dev extra, npm ci in apps/, pre-commit hooks if installed
make ingest       # build the local hazard index from knowledge/sources
make dev          # gateway :8000, form-api :8001, orchestrator :8002, roles :8003, portal :3000
```

`make dev` runs `scripts/dev.sh`: logs are prefixed per service, and Ctrl-C (or any process
exiting) stops everything. The crew view and the supervisor view are both served by the web app
on :3000 (start at the landing page).

In another terminal:

```bash
make replay       # replays samples/briefing_01.json against the running stack
```

Open http://localhost:3000 and sign in as a seeded supervisor (`u-sup-1`) to watch the draft fill.

## Option B: Docker Compose

```bash
docker compose up --build      # or: make compose-up
```

Same ports. Form API data lives in the `crewbrief-data` volume (`docker compose down -v` wipes it).
Containers run read-only as a non-root user; service URLs are rewritten to compose DNS names.

## Using one real Azure service from your laptop

1. Put the real endpoint (and a key only if you cannot use `az login`) in `.env.local`, which
   is git-ignored and overrides `.env`.
2. Switch just that integration: e.g. `LLM_PROVIDER=azure`.
3. `make setup-azure` to install the Azure SDKs.
4. `make check-env` to confirm what is real and what is local (secrets are never printed).

To copy endpoints from an azd environment: `azd env get-values > .env.local`, then delete the
lines you do not want. The outputs never include keys, and public URLs are named `AZURE_*_URL`
so they do not repoint your local stack. Data planes in Azure are private: this only works if
the environment was provisioned with `ALLOW_PUBLIC_NETWORK_ACCESS=true` (personal dev only) or
you are on a network peered with the VNet.

## Quality checks

```bash
make lint typecheck    # ruff + mypy + eslint + tsc
make eval              # offline eval, report in eval/reports/
make schemas           # regenerate JSON Schema for the TypeScript clients
make bicep             # compile the infrastructure
```

## Troubleshooting

| Symptom | Fix |
|---|---|
| `No virtualenv at .venv` | `make setup` |
| Port already in use | Another stack is running: `docker compose down` or stop the old `make dev` |
| Device gets `stt_unavailable_local` | Expected in local mode: send text segments (the app switches automatically) |
| Portal shows no live updates | Check the gateway is up (`curl localhost:8000/readyz`) and `CORS_ORIGINS` includes the portal origin |
| Stale data | Stop the stack and delete `./var` (or `docker compose down -v`) |
